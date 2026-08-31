/**
 * Polyglot LSP Adapter Registry & Factory.
 *
 * Registers all supported language adapters and automatically dispatches
 * requests based on file extensions.
 */

import * as path from 'path';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { KotlinLspAdapter } from '../adapters/kotlin/kotlin-lsp-adapter.js';
import { SpringBootLanguageServerAdapter } from '../adapters/java/spring-boot-adapter.js';
import { springToolsEnabled } from '../adapters/java/spring-tools-runtime.js';
import {
  BazelPreparationReport,
  prepareBazelProjectModels,
  type BazelPreparationOptions,
} from '../adapters/java/bazel-project-model.js';
import {
  discoverJavaBuildRoots,
  JavaBuildRoot,
  JdtlsWorkspace,
  jdtlsHeapXmx,
  ownerBuildRoot,
} from '../adapters/java/jdtls-runtime.js';
import type { PreparedJdtlsShard } from '../adapters/java/jdtls-sharding.js';
import {
  JdtlsStartupTelemetry,
  jdtlsStartupTimeoutMs,
} from '../adapters/java/jdtls-startup-telemetry.js';
import { PyrightAdapter } from '../adapters/python/pyright-adapter.js';
import { ClangdAdapter } from '../adapters/cpp/clangd-adapter.js';
import { RustAnalyzerAdapter } from '../adapters/rust/rust-analyzer-adapter.js';
import { TypeScriptAdapter } from '../adapters/typescript/typescript-adapter.js';
import { CSharpAdapter } from '../adapters/csharp/csharp-adapter.js';
import { CobolAdapter } from '../adapters/cobol/cobol-adapter.js';

export interface JdtlsUriMapping {
  sourcePath: string;
  stagedPath: string;
}

export type LspAdapterFactory = () => ILspAdapter;

/** Build source-root and exact-document mappings once per prepared shard. */
export function buildJdtlsShardUriMappings(shard: PreparedJdtlsShard): JdtlsUriMapping[] {
  return shard.projectModels.flatMap((model) => {
    const allRoots = [...new Set([...model.sourcePaths, ...model.generatedSourcePaths])].sort();
    const rootIndexes = new Map(allRoots.map((sourcePath, index) => [sourcePath, index]));
    return [
      ...allRoots.map((sourcePath, index) => ({
        sourcePath,
        stagedPath: path.join(shard.workspacePath, 'projects', model.projectName, `source-${index}`),
      })),
      ...model.sourceMappings.map((mapping) => {
        const rootIndex = rootIndexes.get(mapping.sourceRoot);
        return {
          sourcePath: mapping.sourcePath,
          stagedPath: rootIndex === undefined
            ? mapping.analysisPath
            : path.join(
              shard.workspacePath, 'projects', model.projectName, `source-${rootIndex}`,
              path.relative(mapping.sourceRoot, mapping.analysisPath),
            ),
        };
      }),
    ];
  });
}

export class LspAdapterRegistry {
  private adapters = new Map<string, ILspAdapter>();
  private adapterFactories = new Map<string, LspAdapterFactory>();
  private activeAdapters = new Map<string, ILspAdapter>();
  private startingAdapters = new Map<string, Promise<ILspAdapter | null>>();
  private javaCompanions = new Map<ILspAdapter, ILspAdapter>();
  private javaLayouts = new Map<string, JavaBuildRoot[]>();
  private preparedBazelRoots = new Set<string>();
  private bazelPreparations = new Map<string, Promise<BazelPreparationReport>>();

  private extensionMap: Record<string, string> = {};

  constructor(factories: LspAdapterFactory[] = defaultAdapterFactories()) {
    for (const factory of factories) this.registerAdapterFactory(factory);
  }

  /** Register one routing prototype. Use registerAdapterFactory for multi-workspace sessions. */
  public registerAdapter(adapter: ILspAdapter): void {
    this.registerAdapterMetadata(adapter);
  }

  /** Register the sole construction boundary for independently owned LSP sessions. */
  public registerAdapterFactory(factory: LspAdapterFactory): void {
    const prototype = factory();
    const language = prototype.language.toLowerCase();
    this.registerAdapterMetadata(prototype);
    this.adapterFactories.set(language, factory);
  }

  private registerAdapterMetadata(adapter: ILspAdapter): void {
    const language = adapter.language.toLowerCase();
    if (this.adapters.has(language)) {
      throw new Error(`LSP adapter is already registered for ${language}`);
    }
    this.adapters.set(language, adapter);
    for (const rawExtension of adapter.fileExtensions ?? []) {
      const extension = rawExtension.toLowerCase();
      if (!/^\.[a-z0-9][a-z0-9.+-]*$/.test(extension)) {
        throw new Error(`Invalid file extension for ${adapter.id}: ${rawExtension}`);
      }
      const current = this.extensionMap[extension];
      if (current && current !== language) {
        throw new Error(`File extension ${extension} is already routed to ${current}`);
      }
      this.extensionMap[extension] = language;
    }
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.adapters.get(language.toLowerCase());
  }

  public getLanguageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensionMap[ext] || null;
  }

  public getSupportedFileExtensions(): string[] {
    return Object.keys(this.extensionMap).sort();
  }

  public getAdapterCatalog(): Array<{ id: string; language: string; fileExtensions: string[] }> {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      language: adapter.language.toLowerCase(),
      fileExtensions: [...(adapter.fileExtensions ?? [])].map((value) => value.toLowerCase()).sort(),
    })).sort((left, right) => left.language.localeCompare(right.language));
  }

  public async getOrStartAdapter(language: string, workspacePath: string): Promise<ILspAdapter | null> {
    const langKey = language.toLowerCase();
    const sessionKey = `${langKey}:${path.resolve(workspacePath)}`;
    if (this.activeAdapters.has(sessionKey)) {
      return this.activeAdapters.get(sessionKey)!;
    }
    const starting = this.startingAdapters.get(sessionKey);
    if (starting) return starting;
    const start = this.startGenericAdapter(langKey, workspacePath, sessionKey);
    this.startingAdapters.set(sessionKey, start);
    try { return await start; }
    finally { this.startingAdapters.delete(sessionKey); }
  }

  private async startGenericAdapter(
    language: string,
    workspacePath: string,
    sessionKey: string,
  ): Promise<ILspAdapter | null> {
    const adapter = this.createAdapter(language);
    if (!adapter) return null;
    if ([...this.activeAdapters.values()].includes(adapter)) {
      throw new Error(
        `Adapter ${adapter.id} is an instance registration already owned by another session; `
        + 'register an adapter factory for multi-workspace use',
      );
    }
    try {
      if (!(await adapter.isAvailable())) return null;
      await adapter.start(workspacePath);
      this.activeAdapters.set(sessionKey, adapter);
      return adapter;
    } catch (error) {
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      console.warn(
        `[LSP Registry] Failed to start adapter for ${language}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  public async getOrStartAdapterForFile(filePath: string, workspacePath: string): Promise<ILspAdapter | null> {
    const lang = this.getLanguageForFile(filePath);
    if (!lang) return null;
    if (lang === 'java') {
      const roots = this.getJavaBuildRoots(workspacePath);
      const root = ownerBuildRoot(filePath, roots);
      if (root) return this.getOrStartJavaBuildRoot(root);
    }
    return this.getOrStartAdapter(lang, workspacePath);
  }

  public getJavaBuildRoots(repositoryPath: string): JavaBuildRoot[] {
    const key = path.resolve(repositoryPath);
    const cached = this.javaLayouts.get(key);
    if (cached) return cached;
    const roots = discoverJavaBuildRoots(key);
    this.javaLayouts.set(key, roots);
    return roots;
  }

  public async prepareJavaBuildRoots(
    repositoryPath: string,
    rootIds?: string[],
    options: Pick<BazelPreparationOptions,
      'buildMode' | 'targetQuery' | 'targetScope' | 'scopeConfigHash' | 'concurrency' | 'timeoutMs'> = {},
  ): Promise<BazelPreparationReport> {
    const key = path.resolve(repositoryPath);
    const selectionKey = `${key}:${[...(rootIds ?? [])].sort().join(',')}:${options.buildMode ?? 'managed'}:${options.targetQuery ?? ''}:${options.scopeConfigHash ?? ''}`;
    const active = this.bazelPreparations.get(selectionKey);
    if (active) return active;
    const selected = rootIds ? new Set(rootIds) : undefined;
    const roots = this.getJavaBuildRoots(key).filter((root) => !selected || selected.has(root.id));
    const preparation = prepareBazelProjectModels(roots, options).then((report) => {
      for (const result of report.roots) {
        if (result.status === 'generated' || result.status === 'cached') {
          this.preparedBazelRoots.add(path.resolve(result.workspacePath));
        }
      }
      return report;
    });
    this.bazelPreparations.set(selectionKey, preparation);
    return preparation;
  }

  public async getOrStartJavaBuildRoot(root: JavaBuildRoot): Promise<ILspAdapter | null> {
    const sessionKey = `java:${root.id}:${root.workspacePath}`;
    const active = this.activeAdapters.get(sessionKey);
    if (active) return active;
    const starting = this.startingAdapters.get(sessionKey);
    if (starting) return starting;
    const start = this.startJavaBuildRoot(root, sessionKey);
    this.startingAdapters.set(sessionKey, start);
    try { return await start; }
    finally { this.startingAdapters.delete(sessionKey); }
  }

  private async startJavaBuildRoot(
    root: JavaBuildRoot,
    sessionKey: string,
  ): Promise<ILspAdapter | null> {
    const adapter = new JavaJdtlsAdapter({
      buildRootId: root.id,
      buildSystems: root.systems,
      excludedRoots: root.excludedRoots,
      bazelModelPrepared: this.preparedBazelRoots.has(path.resolve(root.workspacePath)),
    });
    try {
      if (!(await adapter.isAvailable())) return null;
      await adapter.start(root.workspacePath);
      this.activeAdapters.set(sessionKey, adapter);
      if (springToolsEnabled()) {
        const spring = new SpringBootLanguageServerAdapter(adapter, root.id);
        if (await spring.isAvailable()) {
          try {
            await spring.start(root.workspacePath);
            this.activeAdapters.set(`spring:${root.id}:${root.workspacePath}`, spring);
            this.javaCompanions.set(adapter, spring);
          } catch (error) {
            console.warn(`[LSP Registry] Spring Tools unavailable for ${root.id}:`, error instanceof Error ? error.message : error);
            try { await spring.shutdown(); } catch { /* partial startup */ }
          }
        }
      }
      return adapter;
    } catch (err: any) {
      console.warn(`[LSP Registry] Failed to start Java build root ${root.id}:`, err.message || err);
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      return null;
    }
  }

  /** One long-lived JDT LS process serving several isolated Eclipse projects. */
  public async getOrStartJavaShard(shard: PreparedJdtlsShard): Promise<ILspAdapter | null> {
    const sessionKey = `java-shard:${shard.id}:${shard.workspacePath}`;
    const active = this.activeAdapters.get(sessionKey);
    if (active) return active;
    const starting = this.startingAdapters.get(sessionKey);
    if (starting) return starting;
    const start = this.startJavaShard(shard, sessionKey);
    this.startingAdapters.set(sessionKey, start);
    try { return await start; }
    finally { this.startingAdapters.delete(sessionKey); }
  }

  private async startJavaShard(
    shard: PreparedJdtlsShard,
    sessionKey: string,
  ): Promise<ILspAdapter | null> {
    const usesNativeImport = (root: JavaBuildRoot): boolean => {
      if (root.systems.includes('bazel') || root.systems.length === 0) return false;
      const workspace = JdtlsWorkspace.inspect(root.workspacePath, {
        buildSystems: root.systems,
        excludedRoots: root.excludedRoots,
      });
      return root.systems.some((kind) => kind !== 'bazel' && workspace.buildImportEnabled(kind));
    };
    const nativeBuildSystems = [...new Set(shard.roots
      .filter(usesNativeImport)
      .flatMap((root) => root.systems))];
    const classpathEntryCount = new Set(
      shard.projectModels.flatMap((model) => model.languageServerClasspath.map((entry) => path.resolve(entry))),
    ).size;
    const startupTimeout = jdtlsStartupTimeoutMs(shard.sourceFileCount, classpathEntryCount);
    let adapter: JavaJdtlsAdapter;
    const telemetry = new JdtlsStartupTelemetry({
      shardId: shard.id,
      sourceFileCount: shard.sourceFileCount,
      classpathEntryCount,
      heapXmx: jdtlsHeapXmx(shard.sourceFileCount),
      timeoutMs: startupTimeout,
      processMetadata: () => adapter?.getSessionMetadata() ?? {},
    });
    adapter = new JavaJdtlsAdapter({
      processShardId: shard.id,
      shardBuildRootIds: shard.roots.map((root) => root.id),
      eclipseProjectPaths: shard.projectModels.map((model) =>
        path.join(shard.workspacePath, 'projects', model.projectName)),
      workspaceFolderPaths: [
        ...shard.projectModels.map((model) =>
          path.join(shard.workspacePath, 'projects', model.projectName)),
        ...shard.roots.filter(usesNativeImport).map((root) => root.workspacePath),
      ],
      uriMappings: buildJdtlsShardUriMappings(shard),
      sourceFileCount: shard.sourceFileCount,
      buildSystems: nativeBuildSystems,
      bazelModelPrepared: true,
      startupDeadlineAt: telemetry.deadlineAt,
      startupProgress: (phase) => telemetry.setPhase(phase),
    });
    telemetry.start();
    try {
      if (!(await adapter.isAvailable())) {
        telemetry.finish('failed', 'JDT LS runtime is unavailable');
        return null;
      }
      await adapter.start(shard.workspacePath);
      telemetry.setPhase('classpath-readiness');
      await waitForImportedJavaProjects(
        adapter,
        shard.projectModels,
        shard.id,
        telemetry.deadlineAt,
        (pending) => telemetry.setPendingRoots(pending),
      );
      telemetry.setPendingRoots(0);
      telemetry.finish('complete');
      this.activeAdapters.set(sessionKey, adapter);
      if (springToolsEnabled()) {
        const spring = new SpringBootLanguageServerAdapter(adapter, shard.id);
        if (await spring.isAvailable()) {
          try {
            await spring.start(shard.workspacePath);
            this.activeAdapters.set(`spring-shard:${shard.id}:${shard.workspacePath}`, spring);
            this.javaCompanions.set(adapter, spring);
          } catch (error) {
            console.warn(`[LSP Registry] Spring Tools unavailable for ${shard.id}:`, error instanceof Error ? error.message : error);
            try { await spring.shutdown(); } catch { /* partial startup */ }
          }
        }
      }
      return adapter;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      telemetry.finish('failed', reason.split('\nJDT/LSP stderr tail:')[0]);
      console.warn(`[LSP Registry] Failed to start Java shard ${shard.id}: ${formatProcessFailure(reason, adapter)}`);
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      return null;
    }
  }

  private createAdapter(language: string): ILspAdapter | undefined {
    return this.adapterFactories.get(language)?.() ?? this.getAdapter(language);
  }

  public async shutdownAdapter(adapter: ILspAdapter): Promise<void> {
    const companion = this.javaCompanions.get(adapter);
    if (companion) {
      try { await companion.shutdown(); } catch { /* best-effort companion cleanup */ }
      this.javaCompanions.delete(adapter);
      for (const [key, active] of this.activeAdapters) if (active === companion) this.activeAdapters.delete(key);
    }
    try { await adapter.shutdown(); } catch { /* best-effort session cleanup */ }
    for (const [key, active] of this.activeAdapters) {
      if (active === adapter) this.activeAdapters.delete(key);
    }
  }

  public getJavaCompanion(adapter: ILspAdapter): ILspAdapter | undefined {
    return this.javaCompanions.get(adapter);
  }

  public async shutdownAll(): Promise<void> {
    await Promise.allSettled([...this.startingAdapters.values()]);
    for (const adapter of new Set(this.activeAdapters.values())) {
      try {
        await adapter.shutdown();
      } catch {
        // Ignore error on shutdown
      }
    }
    this.activeAdapters.clear();
    this.startingAdapters.clear();
    this.javaCompanions.clear();
    this.javaLayouts.clear();
    this.preparedBazelRoots.clear();
    this.bazelPreparations.clear();
  }
}

function defaultAdapterFactories(): LspAdapterFactory[] {
  return [
    () => new JavaJdtlsAdapter(),
    () => new KotlinLspAdapter(),
    () => new PyrightAdapter(),
    () => new ClangdAdapter(),
    () => new RustAnalyzerAdapter(),
    () => new TypeScriptAdapter(),
    () => new CSharpAdapter(),
    () => new CobolAdapter(),
  ];
}

/**
 * ServiceReady precedes completion of Eclipse project import. Requiring the
 * project catalog and classpath commands prevents crawl results from depending
 * on which shard happens to win an indexing race.
 */
async function waitForImportedJavaProjects(
  adapter: ILspAdapter,
  projectModels: PreparedJdtlsShard['projectModels'],
  shardId: string,
  deadlineAt?: number,
  onPendingRoots?: (count: number) => void,
): Promise<void> {
  const deadline = deadlineAt ?? Date.now() + 180_000;
  const pending = new Map(projectModels
    .filter((model) => model.representativeDocumentPath)
    .map((model) => [model.buildRootId, model]));
  onPendingRoots?.(pending.size);
  do {
    for (const [rootId, model] of pending) {
      if (Date.now() >= deadline) break;
      try {
        const response = await adapter.request<{ classpaths?: unknown }>('workspace/executeCommand', {
          command: 'java.project.getClasspaths',
          arguments: [adapter.documentUri(model.representativeDocumentPath!), JSON.stringify({ scope: 'runtime' })],
        });
        const actual = new Set(Array.isArray(response.classpaths)
          ? response.classpaths.filter((value): value is string => typeof value === 'string').map((value) => path.resolve(value))
          : []);
        if (model.languageServerClasspath.every((entry) => actual.has(path.resolve(entry)))) {
          pending.delete(rootId);
          onPendingRoots?.(pending.size);
        }
      } catch {
        // Project import/indexing is still in flight.
      }
    }
    if (pending.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (pending.size > 0) {
    throw new Error(
      `[${shardId}] JDT classpath readiness timed out with ${pending.size} pending roots: `
      + [...pending.keys()].join(', '),
    );
  }
}

function formatProcessFailure(reason: string, adapter: ILspAdapter): string {
  const metadata = adapter.getSessionMetadata();
  const processDetail = [
    metadata.processId !== undefined ? `pid=${metadata.processId}` : undefined,
    metadata.processExitCode !== null && metadata.processExitCode !== undefined
      ? `exitCode=${metadata.processExitCode}` : undefined,
    metadata.processSignal ? `signal=${metadata.processSignal}` : undefined,
  ].filter(Boolean).join(', ');
  const stderr = metadata.processStderrTail?.trim();
  return `${reason}${processDetail ? ` (${processDetail})` : ''}`
    + (stderr && !reason.includes('stderr tail:')
      ? `\nJDT stderr tail:\n${stderr.slice(-8 * 1024)}` : '');
}
