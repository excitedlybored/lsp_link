/**
 * Base Stdio LSP Adapter.
 *
 * Provides a robust, reusable implementation of `ILspAdapter` over standard I/O JSON-RPC
 * for any language server (Pyright, Clangd, Rust-Analyzer, TypeScript, CSharp, COBOL, Gopls).
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  LspHoverResult,
  LspImplementationResult,
} from '../contracts/lsp-types.js';

export interface StdioAdapterConfig {
  id: string;
  language: string;
  command: string;
  args: string[];
  initOptions?: Record<string, any>;
  extraCapabilities?: Record<string, any>;
}

export abstract class BaseStdioLspAdapter implements ILspAdapter {
  public abstract readonly id: string;
  public abstract readonly language: string;

  protected process: ChildProcess | null = null;
  protected openedDocuments = new Set<string>();
  protected nextRequestId = 1;
  protected pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  protected incomingBuffer = '';

  public static findBinary(name: string): string | null {
    const searchPaths = [
      path.resolve(process.cwd(), 'node_modules', '.bin', name),
      path.resolve(process.cwd(), '..', 'node_modules', '.bin', name),
      path.join(process.env.HOME || '', '.cargo', 'bin', name),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];

    for (const p of searchPaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  public abstract isAvailable(): Promise<boolean>;

  protected abstract getLaunchConfig(workspacePath: string): Promise<{
    command: string;
    args: string[];
    initOptions?: Record<string, any>;
  }>;

  public async start(workspacePath: string): Promise<void> {
    const launchConfig = await this.getLaunchConfig(workspacePath);

    this.process = spawn(launchConfig.command, launchConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.process.stdout?.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.process.stderr?.on('data', () => {
      // Diagnostic logging ignored
    });

    const rootUri = pathToFileURL(path.resolve(workspacePath)).toString();
    const initParams = {
      processId: process.pid,
      rootUri,
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          callHierarchy: { dynamicRegistration: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { dynamicRegistration: true },
          implementation: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
        },
      },
      initializationOptions: launchConfig.initOptions ?? {},
    };

    await this.sendRequest('initialize', initParams);
    this.sendNotification('initialized', {});
  }

  public async openDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (this.openedDocuments.has(absPath)) return;
    if (!fs.existsSync(absPath)) return;

    const content = fs.readFileSync(absPath, 'utf8');
    const uri = pathToFileURL(absPath).toString();

    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: this.language,
        version: 1,
        text: content,
      },
    });

    this.openedDocuments.add(absPath);
    // Allow brief time for server to index the document
    await new Promise((r) => setTimeout(r, 150));
  }

  public async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number
  ): Promise<CallHierarchyItem[]> {
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const res = await this.sendRequest('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position: { line, character },
    });
    return (res as CallHierarchyItem[]) || [];
  }

  public async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const res = await this.sendRequest('callHierarchy/outgoingCalls', { item });
    return (res as CallHierarchyOutgoingCall[]) || [];
  }

  public async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const res = await this.sendRequest('callHierarchy/incomingCalls', { item });
    return (res as CallHierarchyIncomingCall[]) || [];
  }

  public async findImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspImplementationResult[]> {
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const res = await this.sendRequest('textDocument/implementation', {
      textDocument: { uri },
      position: { line, character },
    });

    if (!res) return [];
    const items = Array.isArray(res) ? res : [res];
    return items.map((it: any) => ({
      uri: it.uri || it.targetUri,
      range: it.range || it.targetRange,
    }));
  }

  public async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspHoverResult | null> {
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const res: any = await this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });

    if (!res || !res.contents) return null;
    let contents = '';
    if (typeof res.contents === 'string') {
      contents = res.contents;
    } else if (Array.isArray(res.contents)) {
      contents = res.contents.map((c: any) => (typeof c === 'string' ? c : c.value)).join('\n');
    } else if (res.contents.value) {
      contents = res.contents.value;
    }

    return { contents, range: res.range };
  }

  public async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.sendRequest('shutdown', {});
      this.sendNotification('exit', {});
    } catch {
      // Ignore errors during shutdown
    }
    this.process.kill('SIGTERM');
    this.process = null;
    this.openedDocuments.clear();
  }

  protected sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.writeMessage(msg);

      // Timeout request after 15 seconds to prevent hangs
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve(null);
        }
      }, 15000);
    });
  }

  protected sendNotification(method: string, params: any): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeMessage(msg);
  }

  private writeMessage(body: string): void {
    if (!this.process?.stdin?.writable) return;
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private handleData(chunk: Buffer): void {
    this.incomingBuffer += chunk.toString('utf8');

    while (true) {
      const headerEnd = this.incomingBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.incomingBuffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.incomingBuffer = this.incomingBuffer.slice(headerEnd + 4);
        continue;
      }

      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.incomingBuffer.length < bodyStart + length) {
        break; // Wait for full body
      }

      const bodyStr = this.incomingBuffer.slice(bodyStart, bodyStart + length);
      this.incomingBuffer = this.incomingBuffer.slice(bodyStart + length);

      try {
        const message = JSON.parse(bodyStr);
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          const { resolve } = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          resolve(message.result);
        }
      } catch {
        // Ignore unparseable frames
      }
    }
  }
}
