/**
 * Stdio language-server adapter using Microsoft `vscode-jsonrpc`.
 *
 * Subclasses supply the process command. This class owns spawn, JSON-RPC,
 * initialize, document open/close, and the query methods on ILspAdapter.
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

export interface StdioProcessLaunch {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

export abstract class BaseStdioLspAdapter implements ILspAdapter {
  public abstract readonly id: string;
  public abstract readonly language: string;
  public readonly maxConcurrentRequests: number = 2;

  protected process: ChildProcess | null = null;
  protected connection: rpc.MessageConnection | null = null;
  protected openedDocuments = new Set<string>();
  private launchSettings: Record<string, unknown> = {};
  private workspaceFolderList: { uri: string; name: string }[] = [];

  public static findBinary(name: string): string | null {
    const searchPaths = [
      path.resolve(process.cwd(), 'node_modules', '.bin', name),
      path.resolve(process.cwd(), '..', 'node_modules', '.bin', name),
      path.join(process.env.HOME || '', '.cargo', 'bin', name),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];

    for (const candidate of searchPaths) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  public abstract isAvailable(): Promise<boolean>;

  protected abstract buildProcessLaunch(workspacePath: string): Promise<StdioProcessLaunch>;

  public async start(workspacePath: string): Promise<void> {
    const launch = await this.buildProcessLaunch(workspacePath);
    this.launchSettings = (launch.initializationOptions?.settings as Record<string, unknown>) ?? {};
    this.spawnLanguageServer(launch);
    this.openJsonRpcConnection();
    await this.performInitializeHandshake(workspacePath, launch);
    this.notifyInitialized();
    await this.waitUntilWorkspaceReady(workspacePath);
  }

  /** Cap on `initialize`. Absent/0 waits until the server answers. */
  protected initializeTimeoutMs(_workspacePath: string): number | undefined {
    return undefined;
  }

  /** Override for compilers that publish ready after `initialized` (JDT.LS ServiceReady). */
  protected async waitUntilWorkspaceReady(_workspacePath: string): Promise<void> {}

  /** Cap on in-flight query RPCs so a stuck compiler cannot hang analyze. */
  protected queryTimeoutMs(): number {
    return 15_000;
  }

  protected onServerNotification(_method: string, _params: unknown): void {}

  /** Answer server→client requests. Leaving these unanswered deadlocks JDT.LS. */
  protected onServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration':
        return workspaceConfigurationResponse(params, this.launchSettings);
      case 'workspace/workspaceFolders':
        return this.workspaceFolderList;
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'window/showDocument':
        return null;
      case 'workspace/applyEdit':
        return { applied: false };
      default:
        return null;
    }
  }

  public async openDocument(filePath: string): Promise<void> {
    const absPath = path.resolve(filePath);
    if (this.openedDocuments.has(absPath)) return;
    if (!fs.existsSync(absPath)) return;

    try {
      this.connection?.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: this.toFileUri(absPath),
          languageId: this.language,
          version: 1,
          text: fs.readFileSync(absPath, 'utf8'),
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
    try {
      this.connection.sendNotification('textDocument/didClose', {
        textDocument: { uri: this.toFileUri(absPath) },
      });
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
    await this.openDocument(filePath);
    const result = await this.sendQuery<CallHierarchyItem[]>('textDocument/prepareCallHierarchy', {
      textDocument: { uri: this.toFileUri(filePath) },
      position: { line, character },
    });
    return result || [];
  }

  public async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const result = await this.sendQuery<CallHierarchyOutgoingCall[]>('callHierarchy/outgoingCalls', {
      item,
    });
    return result || [];
  }

  public async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const result = await this.sendQuery<CallHierarchyIncomingCall[]>('callHierarchy/incomingCalls', {
      item,
    });
    return result || [];
  }

  public async findImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspImplementationResult[]> {
    await this.openDocument(filePath);
    const result = await this.sendQuery<unknown>('textDocument/implementation', {
      textDocument: { uri: this.toFileUri(filePath) },
      position: { line, character },
    });

    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((item: { uri?: string; targetUri?: string; range?: unknown; targetRange?: unknown }) => ({
      uri: item.uri || item.targetUri || '',
      range: (item.range || item.targetRange) as LspImplementationResult['range'],
    }));
  }

  public async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<LspHoverResult | null> {
    await this.openDocument(filePath);
    const result = await this.sendQuery<{ contents?: unknown; range?: LspHoverResult['range'] }>(
      'textDocument/hover',
      {
        textDocument: { uri: this.toFileUri(filePath) },
        position: { line, character },
      }
    );
    if (!result?.contents) return null;
    return { contents: hoverContentsToText(result.contents), range: result.range };
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

  private spawnLanguageServer(launch: StdioProcessLaunch): void {
    this.process = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to create stdio streams for ${this.id}`);
    }

    this.process.stdin.on('error', () => {});
    this.process.stdout.on('error', () => {});
    this.process.stderr?.on('data', () => {});
    this.process.stderr?.on('error', () => {});
    this.process.on('exit', () => {
      this.connection = null;
    });
    this.process.on('error', () => {
      this.connection = null;
    });
  }

  private openJsonRpcConnection(): void {
    if (!this.process?.stdout || !this.process.stdin) {
      throw new Error(`Failed to create stdio streams for ${this.id}`);
    }

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
      this.onServerNotification(method, params);
    });
    this.connection.onRequest((method: string, params: unknown) => {
      return this.onServerRequest(method, params);
    });
  }

  private async performInitializeHandshake(
    workspacePath: string,
    launch: StdioProcessLaunch
  ): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.id} has no JSON-RPC connection`);
    }

    const resolvedRoot = path.resolve(workspacePath);
    const rootUri = pathToFileURL(resolvedRoot).toString();
    this.workspaceFolderList = [{ uri: rootUri, name: path.basename(resolvedRoot) }];
    const initParams = {
      processId: process.pid,
      rootUri,
      rootPath: resolvedRoot,
      workspaceFolders: this.workspaceFolderList,
      capabilities: {
        workspace: {
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
        },
        window: { workDoneProgress: true },
        textDocument: {
          callHierarchy: { dynamicRegistration: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { dynamicRegistration: true },
          implementation: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
        },
      },
      initializationOptions: launch.initializationOptions ?? {},
    };

    const timeoutMs = this.initializeTimeoutMs(workspacePath);
    let initTimer: NodeJS.Timeout | undefined;
    try {
      if (timeoutMs && timeoutMs > 0) {
        const source = new rpc.CancellationTokenSource();
        initTimer = setTimeout(() => {
          try {
            source.cancel();
          } catch {
            // cancel() may throw if the pipe already closed
          }
        }, timeoutMs);
        await this.connection.sendRequest('initialize', initParams, source.token);
      } else {
        await this.connection.sendRequest('initialize', initParams);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        timeoutMs ? `Request initialize timed out after ${timeoutMs}ms (${message})` : message
      );
    } finally {
      if (initTimer) clearTimeout(initTimer);
    }
  }

  private notifyInitialized(): void {
    this.connection?.sendNotification('initialized', {});
  }

  private toFileUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
  }

  private async sendQuery<T>(method: string, params: unknown): Promise<T | undefined> {
    if (!this.connection) return undefined;
    const timeoutMs = this.queryTimeoutMs();
    const source = new rpc.CancellationTokenSource();
    const timer = setTimeout(() => {
      try {
        source.cancel();
      } catch {
        // cancel() may throw if the pipe already closed
      }
    }, timeoutMs);
    try {
      return (await this.connection.sendRequest(method, params, source.token)) as T;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function hoverContentsToText(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((part) => (typeof part === 'string' ? part : part?.value ?? '')).join('\n');
  }
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: unknown }).value);
  }
  return '';
}

function workspaceConfigurationResponse(
  params: unknown,
  settings: Record<string, unknown>
): unknown[] {
  const items = (params as { items?: { section?: string }[] } | null)?.items ?? [];
  return items.map((item) => {
    const section = item.section;
    if (!section) return settings;
    const parts = section.split('.');
    let current: unknown = settings;
    for (const part of parts) {
      if (!current || typeof current !== 'object' || !(part in current)) return {};
      current = (current as Record<string, unknown>)[part];
    }
    return current ?? {};
  });
}
