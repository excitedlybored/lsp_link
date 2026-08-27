/**
 * Polyglot LSP Adapter Registry & Factory.
 *
 * Registers all banking language adapters and automatically dispatches
 * requests based on file extensions.
 */

import * as path from 'path';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { SpringBootLanguageServerAdapter } from '../adapters/java/spring-boot-adapter.js';
import { springToolsEnabled } from '../adapters/java/spring-tools-runtime.js';
import {
  BazelPreparationReport,
  prepareBazelProjectModels,
  type BazelPreparationOptions,
} from '../adapters/java/bazel-project-model.js';
import { discoverJavaBuildRoots, JavaBuildRoot, JdtlsWorkspace, ownerBuildRoot } from '../adapters/java/jdtls-runtime.js';
import type { PreparedJdtlsShard } from '../adapters/java/jdtls-sharding.js';
import { PyrightAdapter } from '../adapters/python/pyright-adapter.js';
import { ClangdAdapter } from '../adapters/cpp/clangd-adapter.js';
import { RustAnalyzerAdapter } from '../adapters/rust/rust-analyzer-adapter.js';
import { TypeScriptAdapter } from '../adapters/typescript/typescript-adapter.js';
import { CSharpAdapter } from '../adapters/csharp/csharp-adapter.js';
import { CobolAdapter } from '../adapters/cobol/cobol-adapter.js';

export class LspAdapterRegistry {
  private adapters = new Map<string, ILspAdapter>();
  private activeAdapters = new Map<string, ILspAdapter>();
  private javaCompanions = new Map<ILspAdapter, ILspAdapter>();
  private javaLayouts = new Map<string, JavaBuildRoot[]>();
  private preparedBazelRoots = new Set<string>();
  private bazelPreparations = new Map<string, Promise<BazelPreparationReport>>();

  private static EXTENSION_MAP: Record<string, string> = {
    '.java': 'java',
    '.py': 'python',
    '.pyi': 'python',
    '.c': 'cpp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.rs': 'rust',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.cs': 'csharp',
    '.cbl': 'cobol',
    '.cob': 'cobol',
    '.cpy': 'cobol',
  };

  constructor() {
    this.registerAdapter(new JavaJdtlsAdapter());
    this.registerAdapter(new PyrightAdapter());
    this.registerAdapter(new ClangdAdapter());
    this.registerAdapter(new RustAnalyzerAdapter());
    this.registerAdapter(new TypeScriptAdapter());
    this.registerAdapter(new CSharpAdapter());
    this.registerAdapter(new CobolAdapter());
  }

  public registerAdapter(adapter: ILspAdapter): void {
    this.adapters.set(adapter.language.toLowerCase(), adapter);
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.adapters.get(language.toLowerCase());
  }

  public getLanguageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return LspAdapterRegistry.EXTENSION_MAP[ext] || null;
  }

  public async getOrStartAdapter(language: string, workspacePath: string): Promise<ILspAdapter | null> {
    const langKey = language.toLowerCase();
    const sessionKey = `${langKey}:${path.resolve(workspacePath)}`;
    if (this.activeAdapters.has(sessionKey)) {
      return this.activeAdapters.get(sessionKey)!;
    }

    const adapter = this.createAdapter(langKey);
    if (!adapter) {
      return null;
    }

    try {
      const available = await adapter.isAvailable();
      if (!available) {
        return null;
      }

      await adapter.start(workspacePath);
      this.activeAdapters.set(sessionKey, adapter);
      return adapter;
    } catch (err: any) {
      console.warn(`[LSP Registry] Failed to start adapter for ${language}:`, err.message || err);
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
    const adapter = new JavaJdtlsAdapter({
      processShardId: shard.id,
      shardBuildRootIds: shard.roots.map((root) => root.id),
      eclipseProjectPaths: shard.projectModels.map((model) =>
        path.join(shard.workspacePath, 'projects', model.projectName)),
      workspaceFolderPaths: [
        ...shard.projectModels.map((model) =>
          path.join(shard.workspacePath, 'projects', model.projectName)),
        ...shard.roots.filter(usesNativeImport).map((root) => root.workspacePath),
      ],
      uriMappings: shard.projectModels.flatMap((model) =>
        [
          ...[...new Set([...model.sourcePaths, ...model.generatedSourcePaths])].sort()
            .map((sourcePath, index) => ({
            sourcePath,
            stagedPath: path.join(shard.workspacePath, 'projects', model.projectName, `source-${index}`),
            })),
          ...model.sourceMappings.map((mapping) => {
            const allRoots = [...new Set([...model.sourcePaths, ...model.generatedSourcePaths])].sort();
            const rootIndex = allRoots.indexOf(mapping.sourceRoot);
            return {
              sourcePath: mapping.sourcePath,
              stagedPath: rootIndex < 0
                ? mapping.analysisPath
                : path.join(
                  shard.workspacePath, 'projects', model.projectName, `source-${rootIndex}`,
                  path.relative(mapping.sourceRoot, mapping.analysisPath),
                ),
            };
          }),
        ]),
      buildSystems: nativeBuildSystems,
      bazelModelPrepared: true,
    });
    try {
      if (!(await adapter.isAvailable())) return null;
      await adapter.start(shard.workspacePath);
      await waitForImportedJavaProjects(adapter, shard.projectModels, shard.id);
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
      console.warn(`[LSP Registry] Failed to start Java shard ${shard.id}:`, error instanceof Error ? error.message : error);
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      return null;
    }
  }

  private createAdapter(language: string): ILspAdapter | undefined {
    switch (language) {
      case 'java': return new JavaJdtlsAdapter();
      case 'python': return new PyrightAdapter();
      case 'cpp': return new ClangdAdapter();
      case 'rust': return new RustAnalyzerAdapter();
      case 'typescript': return new TypeScriptAdapter();
      case 'csharp': return new CSharpAdapter();
      case 'cobol': return new CobolAdapter();
      default: return this.getAdapter(language);
    }
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
    for (const adapter of this.activeAdapters.values()) {
      try {
        await adapter.shutdown();
      } catch {
        // Ignore error on shutdown
      }
    }
    this.activeAdapters.clear();
    this.javaCompanions.clear();
    this.javaLayouts.clear();
    this.preparedBazelRoots.clear();
    this.bazelPreparations.clear();
  }
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
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const pending = new Map(projectModels
    .filter((model) => model.representativeDocumentPath)
    .map((model) => [model.buildRootId, model]));
  do {
    for (const [rootId, model] of pending) {
      try {
        const response = await adapter.request<{ classpaths?: unknown }>('workspace/executeCommand', {
          command: 'java.project.getClasspaths',
          arguments: [adapter.documentUri(model.representativeDocumentPath!), JSON.stringify({ scope: 'runtime' })],
        });
        const actual = new Set(Array.isArray(response.classpaths)
          ? response.classpaths.filter((value): value is string => typeof value === 'string').map((value) => path.resolve(value))
          : []);
        if (model.languageServerClasspath.every((entry) => actual.has(path.resolve(entry)))) pending.delete(rootId);
      } catch {
        // Project import/indexing is still in flight.
      }
    }
    if (pending.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (pending.size > 0) {
    console.warn(`[${shardId}] JDT classpath readiness incomplete for: ${[...pending.keys()].join(', ')}`);
  }
}
