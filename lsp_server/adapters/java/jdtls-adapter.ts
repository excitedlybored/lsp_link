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
  sourceFileCount?: number;
  startupDeadlineAt?: number;
  startupProgress?: (phase: string) => void;
}

export interface JdtlsClientCommand {
  command: string;
  arguments: unknown[];
}

export type JdtlsClientCommandHandler = (command: JdtlsClientCommand) => unknown;

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

  async waitUntilServiceReady(timeoutMs: number): Promise<boolean> {
    if (this.serviceReady) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.serviceReadyResolve = resolve;
          if (this.serviceReady) resolve();
        }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.serviceReadyResolve = null;
    }
    return this.serviceReady;
  }

  async waitUntilStatusQuiet(quietMs: number, capMs: number): Promise<boolean> {
    const settleStart = Date.now();
    while (Date.now() - settleStart < capMs) {
      const idleFor = Date.now() - (this.lastStatusAt || settleStart);
      if (idleFor >= quietMs) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }
}

export class JavaJdtlsAdapter extends BaseStdioLspAdapter {
  public readonly id = 'jdtls';
  public readonly language = 'java';
  public readonly fileExtensions = ['.java'] as const;
  public readonly maxConcurrentRequests = 1;

  private workspace: JdtlsWorkspace | null = null;
  private readonly status = new JdtlsStatusTracker();
  private readonly sourceToStaged: Map<string, string>;
  private readonly stagedToSource: Map<string, string>;
  private readonly clientCommandHandlers = new Set<JdtlsClientCommandHandler>();

  constructor(private readonly options: JavaJdtlsAdapterOptions = {}) {
    super();
    this.sourceToStaged = uriMappingIndex(options.uriMappings ?? [], 'toStaged');
    this.stagedToSource = uriMappingIndex(options.uriMappings ?? [], 'toSource');
  }

  public override getSessionMetadata() {
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

  /** Spring Tools registers a JDT classpath callback through this client command channel. */
  public addClientCommandHandler(handler: JdtlsClientCommandHandler): () => void {
    this.clientCommandHandlers.add(handler);
    return () => this.clientCommandHandlers.delete(handler);
  }

  protected override onServerRequest(method: string, params: unknown): unknown {
    if (method === 'workspace/executeClientCommand') {
      const command = params as { command?: unknown; arguments?: unknown } | null;
      if (typeof command?.command !== 'string') return null;
      const normalized: JdtlsClientCommand = {
        command: command.command,
        arguments: Array.isArray(command.arguments) ? command.arguments : [],
      };
      return Promise.all([...this.clientCommandHandlers].map((handler) => handler(normalized)));
    }
    return super.onServerRequest(method, params);
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
    const mappings = direction === 'toStaged' ? this.sourceToStaged : this.stagedToSource;
    const resolvedFile = path.resolve(filePath);
    let candidate = resolvedFile;
    while (true) {
      const target = mappings.get(uriMappingKey(candidate));
      if (target !== undefined) return path.resolve(target, path.relative(candidate, resolvedFile));
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
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
    if (this.options.startupDeadlineAt !== undefined) return this.remainingStartupMs('initialize');
    return this.workspace?.initializeTimeoutMs() ?? 60_000;
  }

  protected async waitUntilWorkspaceReady(_workspacePath: string): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    this.options.startupProgress?.('service-ready');
    const serviceReady = await this.status.waitUntilServiceReady(
      this.options.startupDeadlineAt === undefined
        ? workspace.serviceReadyTimeoutMs()
        : this.remainingStartupMs('service-ready'),
    );
    if (!serviceReady) throw new Error('JDT service readiness timed out');
    // Indexing still runs after ServiceReady. Querying during that window
    // just hits per-RPC timeouts. Wait until status is quiet, then enrich.
    this.options.startupProgress?.('project-import');
    const quiet = await this.status.waitUntilStatusQuiet(
      workspace.importBuildTools() ? 4000 : 2000,
      this.options.startupDeadlineAt === undefined
        ? workspace.importQuietTimeoutMs()
        : this.remainingStartupMs('project-import'),
    );
    if (!quiet) throw new Error('JDT project import did not become quiet before the startup deadline');
  }

  protected override onStartupPhase(phase: string): void {
    this.options.startupProgress?.(phase);
  }

  protected async buildProcessLaunch(workspacePath: string): Promise<StdioProcessLaunch> {
    this.workspace = JdtlsWorkspace.inspect(workspacePath, {
      buildSystems: this.options.buildSystems,
      excludedRoots: this.options.excludedRoots,
      eclipseProjectImport: Boolean(this.options.eclipseProjectPaths?.length),
      sourceFileCount: this.options.sourceFileCount,
    });
    if (this.workspace.usesBazel && this.workspace.buildImportEnabled('bazel') && !this.options.bazelModelPrepared) {
      const result = await ensureBazelProjectModel(workspacePath);
      if (result.status === 'failed') console.warn(`[jdtls] ${result.reason}`);
      if (result.status === 'generated') {
        this.workspace = JdtlsWorkspace.inspect(workspacePath, {
          buildSystems: this.options.buildSystems,
          excludedRoots: this.options.excludedRoots,
          eclipseProjectImport: Boolean(this.options.eclipseProjectPaths?.length),
          sourceFileCount: this.options.sourceFileCount,
        });
      }
    }
    const runtime = JdtlsRuntimeLocator.locate(this.workspace.requiredJavaMajor);
    const launch = createJdtlsProcessLaunch(
      workspacePath,
      this.workspace,
      runtime,
      path.join(workspacePath, '.jdtls-data'),
    );
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

  private remainingStartupMs(phase: string): number {
    const remaining = (this.options.startupDeadlineAt ?? Date.now()) - Date.now();
    if (remaining <= 0) throw new Error(`JDT startup deadline exceeded during ${phase}`);
    return remaining;
  }
}

function uriMappingIndex(
  mappings: NonNullable<JavaJdtlsAdapterOptions['uriMappings']>,
  direction: 'toStaged' | 'toSource',
): Map<string, string> {
  const result = new Map<string, string>();
  for (const mapping of mappings) {
    const from = path.resolve(direction === 'toStaged' ? mapping.sourcePath : mapping.stagedPath);
    // Preserve the first mapping, matching the stable-sort/first-match policy
    // used before this lookup became an ancestor map.
    const key = uriMappingKey(from);
    if (!result.has(key)) {
      result.set(key, path.resolve(direction === 'toStaged' ? mapping.stagedPath : mapping.sourcePath));
    }
  }
  return result;
}

function uriMappingKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
