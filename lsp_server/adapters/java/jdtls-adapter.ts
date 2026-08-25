/**
 * Eclipse JDT.LS adapter: same vscode-jsonrpc transport as other languages,
 * with compiler-sized initialize wait and ServiceReady tracking.
 */

import { BaseStdioLspAdapter, StdioProcessLaunch } from '../base-stdio-adapter.js';
import {
  createJdtlsProcessLaunch,
  JavaBuildSystemKind,
  JdtlsRuntimeLocator,
  JdtlsWorkspace,
} from './jdtls-runtime.js';
import { ensureBazelProjectModel } from './bazel-project-model.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface JavaJdtlsAdapterOptions {
  buildRootId?: string;
  buildSystems?: JavaBuildSystemKind[];
  excludedRoots?: string[];
  bazelModelPrepared?: boolean;
  processShardId?: string;
  shardBuildRootIds?: string[];
  eclipseProjectPaths?: string[];
  workspaceFolderPaths?: string[];
  uriMappings?: Array<{ sourcePath: string; stagedPath: string }>;
}

/** Tracks `language/status` until ServiceReady and Maven/Gradle import go quiet. */
class JdtlsStatusTracker {
  private serviceReady = false;
  private serviceReadyResolve: (() => void) | null = null;
  private lastStatusAt = 0;

  noteLanguageStatus(params: unknown): void {
    this.lastStatusAt = Date.now();
    const type = (params as { type?: string } | null)?.type;
    if (type === 'ServiceReady' || type === 'Started') {
      this.serviceReady = true;
      this.serviceReadyResolve?.();
    }
  }

  async waitUntilServiceReady(timeoutMs: number): Promise<void> {
    if (this.serviceReady) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.serviceReadyResolve = resolve;
        if (this.serviceReady) resolve();
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async waitUntilStatusQuiet(quietMs: number, capMs: number): Promise<void> {
    const settleStart = Date.now();
    while (Date.now() - settleStart < capMs) {
      const idleFor = Date.now() - (this.lastStatusAt || settleStart);
      if (idleFor >= quietMs) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export class JavaJdtlsAdapter extends BaseStdioLspAdapter {
  public readonly id = 'jdtls';
  public readonly language = 'java';
  public readonly maxConcurrentRequests = 1;

  private workspace: JdtlsWorkspace | null = null;
  private readonly status = new JdtlsStatusTracker();

  constructor(private readonly options: JavaJdtlsAdapterOptions = {}) {
    super();
  }

  public override getSessionMetadata(): {
    workspacePath?: string; buildRootId?: string; buildRootIds?: string[];
    buildSystems?: string[]; processShardId?: string;
  } {
    return {
      ...super.getSessionMetadata(),
      buildRootId: this.options.buildRootId,
      buildRootIds: this.options.shardBuildRootIds,
      buildSystems: this.options.buildSystems,
      processShardId: this.options.processShardId,
    };
  }

  protected override initializeWorkspaceFolders(workspacePath: string): { uri: string; name: string }[] {
    const folders = this.options.workspaceFolderPaths;
    if (!folders?.length) return super.initializeWorkspaceFolders(workspacePath);
    return folders.map((folderPath) => ({
      uri: pathToFileURL(folderPath).href,
      name: path.basename(folderPath),
    }));
  }

  protected override initializeRootPath(workspacePath: string): string {
    return path.resolve(this.options.workspaceFolderPaths?.[0] ?? workspacePath);
  }

  public async isAvailable(): Promise<boolean> {
    return JdtlsRuntimeLocator.isInstalled();
  }

  public override documentUri(filePath: string): string {
    return jdtFileUri(this.mapFilePath(path.resolve(filePath), 'toStaged'));
  }

  public override async request<T>(method: string, params: unknown): Promise<T> {
    const mappedParams = this.mapProtocolUris(params, 'toStaged');
    try {
      const result = await super.request<unknown>(method, mappedParams);
      return this.mapProtocolUris(result, 'toSource') as T;
    } catch (error) {
      // JDT LS emits an invalid JSON-RPC envelope with neither `result` nor
      // `error` for typeDefinition on Java primitives and synthetic array
      // properties such as `array.length`. The protocol result is nullable;
      // normalize only this exact provider quirk to the semantically correct
      // empty result while preserving every genuine transport/server error.
      if (isJdtlsEmptyTypeDefinitionResponse(method, error)) return null as T;
      throw error;
    }
  }

  public override takeNotifications<T>(method: string): T[] {
    return super.takeNotifications<unknown>(method)
      .map((value) => this.mapProtocolUris(value, 'toSource') as T);
  }

  private mapProtocolUris(value: unknown, direction: 'toStaged' | 'toSource'): unknown {
    if (typeof value === 'string' && value.startsWith('file:')) {
      try {
        const mapped = this.mapFilePath(fileURLToPath(value), direction);
        return direction === 'toStaged' ? jdtFileUri(mapped) : pathToFileURL(mapped).href;
      } catch { return value; }
    }
    if (Array.isArray(value)) return value.map((entry) => this.mapProtocolUris(entry, direction));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, this.mapProtocolUris(entry, direction)]));
    }
    return value;
  }

  private mapFilePath(filePath: string, direction: 'toStaged' | 'toSource'): string {
    const mappings = this.options.uriMappings ?? [];
    const ordered = [...mappings].sort((left, right) => {
      const leftBase = direction === 'toStaged' ? left.sourcePath : left.stagedPath;
      const rightBase = direction === 'toStaged' ? right.sourcePath : right.stagedPath;
      return rightBase.length - leftBase.length;
    });
    for (const mapping of ordered) {
      const from = path.resolve(direction === 'toStaged' ? mapping.sourcePath : mapping.stagedPath);
      const relative = path.relative(from, path.resolve(filePath));
      if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        const to = direction === 'toStaged' ? mapping.stagedPath : mapping.sourcePath;
        return path.resolve(to, relative);
      }
    }
    return filePath;
  }

  protected onServerNotification(method: string, params: unknown): void {
    if (method === 'language/status') this.status.noteLanguageStatus(params);
  }

  protected queryTimeoutMs(): number {
    return this.workspace?.importBuildTools() ? 20_000 : 12_000;
  }

  protected initializeTimeoutMs(_workspacePath: string): number | undefined {
    return this.workspace?.initializeTimeoutMs() ?? 60_000;
  }

  protected async waitUntilWorkspaceReady(_workspacePath: string): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    await this.status.waitUntilServiceReady(workspace.serviceReadyTimeoutMs());
    // Indexing still runs after ServiceReady. Querying during that window
    // just hits per-RPC timeouts. Wait until status is quiet, then enrich.
    await this.status.waitUntilStatusQuiet(
      workspace.importBuildTools() ? 4000 : 2000,
      workspace.importQuietTimeoutMs()
    );
  }

  protected async buildProcessLaunch(workspacePath: string): Promise<StdioProcessLaunch> {
    this.workspace = JdtlsWorkspace.inspect(workspacePath, {
      buildSystems: this.options.buildSystems,
      excludedRoots: this.options.excludedRoots,
      eclipseProjectImport: Boolean(this.options.eclipseProjectPaths?.length),
    });
    if (this.workspace.usesBazel && this.workspace.buildImportEnabled('bazel') && !this.options.bazelModelPrepared) {
      const result = await ensureBazelProjectModel(workspacePath);
      if (result.status === 'failed') console.warn(`[jdtls] ${result.reason}`);
      if (result.status === 'generated') {
        this.workspace = JdtlsWorkspace.inspect(workspacePath, {
          buildSystems: this.options.buildSystems,
          excludedRoots: this.options.excludedRoots,
          eclipseProjectImport: Boolean(this.options.eclipseProjectPaths?.length),
        });
      }
    }
    const runtime = JdtlsRuntimeLocator.locate(this.workspace.requiredJavaMajor);
    const launch = createJdtlsProcessLaunch(workspacePath, this.workspace, runtime);
    // JDT LS builds Preferences.rootPaths from its own initialization option,
    // not from the standard InitializeParams.workspaceFolders field. Keep both
    // populated so every generated project is imported during initialisation.
    const jdtWorkspaceFolders = this.initializeWorkspaceFolders(workspacePath)
      .map((folder) => folder.uri);
    return {
      ...launch,
      initializationOptions: {
        ...launch.initializationOptions,
        workspaceFolders: jdtWorkspaceFolders,
      },
    };
  }
}

export function isJdtlsEmptyTypeDefinitionResponse(method: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return method === 'textDocument/typeDefinition'
    && message.includes('The received response has neither a result nor an error property.');
}

function jdtFileUri(filePath: string): string {
  const standard = pathToFileURL(filePath).href;
  return process.platform === 'win32' ? standard : standard.replace(/^file:\/\/\//, 'file:/');
}
