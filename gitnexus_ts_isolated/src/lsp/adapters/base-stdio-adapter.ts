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
    this.connection.onError(() => {
      this.connection = null;
    });
    this.connection.onClose(() => {
      this.connection = null;
    });
    this.connection.onNotification((method: string, params: unknown) => {
      this.handleNotification(method, params);
    });

    const resolvedRoot = path.resolve(workspacePath);
    const rootUri = pathToFileURL(resolvedRoot).toString();
    const initParams = {
      processId: process.pid,
      rootUri,
      rootPath: resolvedRoot,
      workspaceFolders: [{ uri: rootUri, name: path.basename(resolvedRoot) }],
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

    let initTimer: NodeJS.Timeout | undefined;
    const initTimeoutMs = this.initializeTimeoutMs(workspacePath);
    try {
      if (initTimeoutMs && initTimeoutMs > 0) {
        const source = new rpc.CancellationTokenSource();
        initTimer = setTimeout(() => {
          try {
            source.cancel();
          } catch {
            // cancel() may throw if the pipe already closed
          }
        }, initTimeoutMs);
        await this.connection.sendRequest('initialize', initParams, source.token);
      } else {
        await this.connection.sendRequest('initialize', initParams);
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      throw new Error(
        initTimeoutMs
          ? `Request initialize timed out after ${initTimeoutMs}ms (${msg})`
          : msg
      );
    } finally {
      if (initTimer) clearTimeout(initTimer);
    }
    this.connection.sendNotification('initialized', {});
    await this.afterHandshake(workspacePath);
  }

  /** Override to cap initialize wait. Absent/0 = wait until the server answers. */
  protected initializeTimeoutMs(_workspacePath: string): number | undefined {
    return undefined;
  }

  /** Optional compiler-ready wait (e.g. JDT.LS ServiceReady). */
  protected async afterHandshake(_workspacePath: string): Promise<void> {}

  protected handleNotification(_method: string, _params: unknown): void {}

  public async openDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (this.openedDocuments.has(absPath)) return;
    if (!fs.existsSync(absPath)) return;

    const content = fs.readFileSync(absPath, 'utf8');
    const uri = pathToFileURL(absPath).toString();

    try {
      this.connection?.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.language,
          version: 1,
          text: content,
        },
      });
      this.openedDocuments.add(absPath);
    } catch {
      // Dead pipe — caller treats this file as unenriched
    }
  }

  public async closeDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (!this.openedDocuments.has(absPath) || !this.connection) return;
    const uri = pathToFileURL(absPath).toString();
    try {
      this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    } catch {
      // Dead pipe
    }
    this.openedDocuments.delete(absPath);
  }

  public async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number
  ): Promise<CallHierarchyItem[]> {
    if (!this.connection) return [];
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    try {
      const res = await this.connection.sendRequest('textDocument/prepareCallHierarchy', {
        textDocument: { uri },
        position: { line, character },
      });
      return (res as CallHierarchyItem[]) || [];
    } catch {
      return [];
    }
  }

  public async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    if (!this.connection) return [];
    try {
      const res = await this.connection.sendRequest('callHierarchy/outgoingCalls', { item });
      return (res as CallHierarchyOutgoingCall[]) || [];
    } catch {
      return [];
    }
  }

  public async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    if (!this.connection) return [];
    try {
      const res = await this.connection.sendRequest('callHierarchy/incomingCalls', { item });
      return (res as CallHierarchyIncomingCall[]) || [];
    } catch {
      return [];
    }
  }

  public async findImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspImplementationResult[]> {
    if (!this.connection) return [];
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    try {
      const res: any = await this.connection.sendRequest('textDocument/implementation', {
        textDocument: { uri },
        position: { line, character },
      });

      if (!res) return [];
      const items = Array.isArray(res) ? res : [res];
      return items.map((it: any) => ({
        uri: it.uri || it.targetUri,
        range: it.range || it.targetRange,
      }));
    } catch {
      return [];
    }
  }

  public async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspHoverResult | null> {
    if (!this.connection) return null;
    await this.openDocument(filePath);
    const uri = pathToFileURL(path.resolve(filePath)).toString();
    try {
      const res: any = await this.connection.sendRequest('textDocument/hover', {
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
    } catch {
      return null;
    }
  }

  public async shutdown(): Promise<void> {
    const stdinAlive = Boolean(this.process?.stdin && !this.process.stdin.destroyed);
    if (this.connection && stdinAlive) {
      try {
        await this.connection.sendRequest('shutdown', {});
        this.connection.sendNotification('exit', {});
      } catch {
        // Ignore shutdown errors
      }
    }
    try {
      this.connection?.dispose();
    } catch {
      // Ignore dispose errors
    }
    this.connection = null;

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // Already gone
      }
      this.process = null;
    }
    this.openedDocuments.clear();
  }
}
