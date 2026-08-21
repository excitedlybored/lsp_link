/**
 * Base Stdio LSP Adapter powered by official Microsoft `vscode-jsonrpc`.
 *
 * Uses `vscode-jsonrpc` and `vscode-languageserver-protocol` to provide
 * enterprise-grade JSON-RPC 2.0 connection management for any Language Server.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as rpc from 'vscode-jsonrpc/node';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  LspHoverResult,
  LspImplementationResult,
} from '../contracts/lsp-types.js';

export abstract class BaseStdioLspAdapter implements ILspAdapter {
  public abstract readonly id: string;
  public abstract readonly language: string;

  protected process: ChildProcess | null = null;
  protected connection: rpc.MessageConnection | null = null;
  protected openedDocuments = new Set<string>();

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

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to create stdio streams for ${this.id}`);
    }

    // Prevent an unhandled 'error' event on a dead pipe from crashing the process,
    // and drop the connection reference once the server process is gone so later
    // sendRequest/sendNotification calls short-circuit instead of writing to a
    // destroyed stream.
    this.process.stdin.on('error', () => {});
    this.process.stdout.on('error', () => {});
    this.process.on('exit', () => {
      this.connection = null;
    });
    this.process.on('error', () => {
      this.connection = null;
    });

    // Official Microsoft JSON-RPC message connection
    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.process.stdout),
      new rpc.StreamMessageWriter(this.process.stdin)
    );

    this.connection.listen();

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

    await this.connection.sendRequest('initialize', initParams);
    this.connection.sendNotification('initialized', {});
  }

  public async openDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (this.openedDocuments.has(absPath)) return;
    if (!fs.existsSync(absPath)) return;

    const content = fs.readFileSync(absPath, 'utf8');
    const uri = pathToFileURL(absPath).toString();

    this.connection?.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: this.language,
        version: 1,
        text: content,
      },
    });

    this.openedDocuments.add(absPath);
  }

  public async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number
  ): Promise<CallHierarchyItem[]> {
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const res = await this.connection?.sendRequest('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position: { line, character },
    });
    return (res as CallHierarchyItem[]) || [];
  }

  public async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const res = await this.connection?.sendRequest('callHierarchy/outgoingCalls', { item });
    return (res as CallHierarchyOutgoingCall[]) || [];
  }

  public async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const res = await this.connection?.sendRequest('callHierarchy/incomingCalls', { item });
    return (res as CallHierarchyIncomingCall[]) || [];
  }

  public async findImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspImplementationResult[]> {
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    const res: any = await this.connection?.sendRequest('textDocument/implementation', {
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
    const res: any = await this.connection?.sendRequest('textDocument/hover', {
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
    if (this.connection) {
      try {
        await this.connection.sendRequest('shutdown', {});
        this.connection.sendNotification('exit', {});
      } catch {
        // Ignore shutdown errors
      }
      this.connection.dispose();
      this.connection = null;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.openedDocuments.clear();
  }
}
