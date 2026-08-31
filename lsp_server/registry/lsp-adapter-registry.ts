/**
 * Polyglot LSP Adapter Registry & Factory.
 *
 * Registers all supported language adapters and automatically dispatches
 * requests based on file extensions.
 */

import * as path from 'path';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import {
  BazelPreparationReport,
  prepareBazelProjectModels,
  type BazelPreparationOptions,
} from '../adapters/java/bazel-project-model.js';
import {
  discoverJavaBuildRoots,
  enabledNativeJdtBuildSystems,
  JavaBuildRoot,
  jdtlsHeapXmx,
  ownerBuildRoot,
  usesNativeJdtImport,
} from '../adapters/java/jdtls-runtime.js';
import type { PreparedJdtlsShard } from '../adapters/java/jdtls-sharding.js';
import {
  JdtlsStartupTelemetry,
  jdtlsStartupTimeoutMs,
} from '../adapters/java/jdtls-startup-telemetry.js';
import { awaitJdtIndex } from '../adapters/java/jdtls-index-readiness.js';
import { validateImportedJavaProjectClasspaths } from '../adapters/java/jdtls-classpath-validation.js';
import { formatJdtlsProcessFailure } from '../adapters/java/jdtls-process-diagnostics.js';
import { buildJdtlsShardUriMappings } from '../adapters/java/jdtls-uri-mapping.js';
import { SpringCompanionManager } from '../adapters/java/spring-companion-manager.js';
import {
  LspAdapterCatalog,
  type LspAdapterFactory,
} from './adapter-catalog.js';

export class LspAdapterRegistry {
  private readonly catalog: LspAdapterCatalog;
  private activeAdapters = new Map<string, ILspAdapter>();
  private startingAdapters = new Map<string, Promise<ILspAdapter | null>>();
  private readonly springCompanions = new SpringCompanionManager();
  private javaLayouts = new Map<string, JavaBuildRoot[]>();
  private preparedBazelRoots = new Set<string>();
  private bazelPreparations = new Map<string, Promise<BazelPreparationReport>>();

  constructor(factories?: LspAdapterFactory[]) {
    this.catalog = new LspAdapterCatalog(factories);
  }

  /** Register one routing prototype. Use registerAdapterFactory for multi-workspace sessions. */
  public registerAdapter(adapter: ILspAdapter): void {
    this.catalog.registerAdapter(adapter);
  }

  /** Register the sole construction boundary for independently owned LSP sessions. */
  public registerAdapterFactory(factory: LspAdapterFactory): void {
    this.catalog.registerFactory(factory);
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.catalog.getAdapter(language);
  }

  public getLanguageForFile(filePath: string): string | null {
    return this.catalog.getLanguageForFile(filePath);
  }

  public getSupportedFileExtensions(): string[] {
    return this.catalog.getSupportedFileExtensions();
  }

  public getAdapterCatalog(): Array<{ id: string; language: string; fileExtensions: string[] }> {
    return this.catalog.entries();
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
      const companion = await this.springCompanions.start(adapter, root);
      if (companion) this.activeAdapters.set(`spring:${root.id}:${root.workspacePath}`, companion);
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
    const nativeRoots = shard.roots.filter(usesNativeJdtImport);
    const nativeRootIds = new Set(nativeRoots.map((root) => root.id));
    const externalProjectModels = shard.projectModels
      .filter((model) => !nativeRootIds.has(model.buildRootId));
    const nativeBuildSystems = [...new Set(nativeRoots
      .flatMap(enabledNativeJdtBuildSystems))];
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
      eclipseProjectPaths: externalProjectModels.map((model) =>
        path.join(shard.workspacePath, 'projects', model.projectName)),
      workspaceFolderPaths: [
        ...externalProjectModels.map((model) =>
          path.join(shard.workspacePath, 'projects', model.projectName)),
        ...nativeRoots.map((root) => root.workspacePath),
      ],
      uriMappings: buildJdtlsShardUriMappings(shard, externalProjectModels),
      sourceFileCount: shard.sourceFileCount,
      buildSystems: nativeBuildSystems,
      bazelModelPrepared: true,
      startupDeadlineAt: telemetry.deadlineAt,
      startupProgress: (phase) => telemetry.setPhase(phase),
      serverProgress: (progress) => telemetry.noteServerProgress(progress),
    });
    telemetry.start();
    try {
      if (!(await adapter.isAvailable())) {
        telemetry.finish('failed', 'JDT LS runtime is unavailable');
        return null;
      }
      await adapter.start(shard.workspacePath);
      telemetry.setPhase('jdt-index-readiness');
      const indexStartedAt = Date.now();
      await awaitJdtIndex(adapter, shard.id);
      console.log(`[jdtls-stage] ${JSON.stringify({
        shardId: shard.id, phase: 'jdt-index-readiness', status: 'complete',
        elapsedMs: Date.now() - indexStartedAt,
      })}`);
      telemetry.setPhase('classpath-validation');
      const validationStartedAt = Date.now();
      await validateImportedJavaProjectClasspaths(
        adapter,
        shard.projectModels,
        shard.id,
        telemetry.deadlineAt,
        (pending) => telemetry.setPendingRoots(pending),
        (progress) => telemetry.setClasspathReadiness(progress),
      );
      console.log(`[jdtls-stage] ${JSON.stringify({
        shardId: shard.id, phase: 'classpath-validation', status: 'complete',
        elapsedMs: Date.now() - validationStartedAt,
      })}`);
      telemetry.setPendingRoots(0);
      telemetry.finish('complete');
      this.activeAdapters.set(sessionKey, adapter);
      for (const root of shard.roots) {
        const model = shard.projectModels.find((candidate) => candidate.buildRootId === root.id);
        const companion = await this.springCompanions.start(adapter, root, model);
        if (companion) this.activeAdapters.set(`spring:${root.id}:${root.workspacePath}`, companion);
      }
      return adapter;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      telemetry.finish('failed', reason.split('\nJDT/LSP stderr tail:')[0]);
      console.warn(`[LSP Registry] Failed to start Java shard ${shard.id}: ${formatJdtlsProcessFailure(reason, adapter)}`);
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      return null;
    }
  }

  private createAdapter(language: string): ILspAdapter | undefined {
    return this.catalog.createAdapter(language);
  }

  public async shutdownAdapter(adapter: ILspAdapter): Promise<void> {
    const companions = await this.springCompanions.shutdown(adapter);
    for (const companion of companions) {
      for (const [key, active] of this.activeAdapters) if (active === companion) this.activeAdapters.delete(key);
    }
    try { await adapter.shutdown(); } catch { /* best-effort session cleanup */ }
    for (const [key, active] of this.activeAdapters) {
      if (active === adapter) this.activeAdapters.delete(key);
    }
  }

  public getJavaCompanion(adapter: ILspAdapter, buildRootId?: string): ILspAdapter | undefined {
    return this.springCompanions.get(adapter, buildRootId);
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
    this.springCompanions.clear();
    this.javaLayouts.clear();
    this.preparedBazelRoots.clear();
    this.bazelPreparations.clear();
  }
}
