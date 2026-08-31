import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';

import type { RepositoryInventoryBatch } from '../repository/model.js';
import { buildRepositoryInventory } from '../repository/inventory.js';
import {
  fingerprintPipelineInputs,
  PipelineCheckpointStore,
} from '../pipeline/checkpoints.js';
import { addConfiguredJavaSources, findJavaSourceFiles } from '../pipeline/java-source-files.js';
import type {
  JavaBuildRootPreparation,
  LspKnowledgeGraphBuildOptions,
} from '../pipeline/types.js';
import {
  LspAdapterRegistry,
  ownerBuildRoot,
  type BazelRootPreparationResult,
  type JavaBuildRoot,
} from '../../../lsp_server/public-api.js';
import { discoverRegisteredSemanticSources } from './polyglot-crawl-stage.js';

export interface PreparedPipeline {
  readonly workspacePath: string;
  readonly repositoryInventory: RepositoryInventoryBatch;
  readonly preparation: readonly BazelRootPreparationResult[];
  readonly activeRoots: readonly JavaBuildRoot[];
  readonly filesByRoot: ReadonlyMap<string, string[]>;
  readonly registeredSemanticFiles: readonly string[];
  readonly checkpointStore: PipelineCheckpointStore;
  readonly crawlFingerprint: string;
}

/** Discovers and fingerprints all inputs before any language server is started. */
export async function preparePipeline(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
): Promise<PreparedPipeline> {
  const workspacePath = path.resolve(options.workspace);
  const repositoryInventory = await buildRepositoryInventory(workspacePath, {
    concurrency: options.concurrency,
  });
  console.log(
    `[stage:repository-inventory] ${repositoryInventory.documents.length} documents, `
    + `${repositoryInventory.declarations.length} lexical declarations`,
  );

  const discoveredRoots = adapterRegistry.getJavaBuildRoots(workspacePath);
  const repositoryJavaFiles = findJavaSourceFiles(workspacePath);
  const preparedBuildRoots = await adapterRegistry.prepareJavaBuildRoots(
    workspacePath,
    undefined,
    {
      buildMode: options.bazelBuildMode,
      targetQuery: options.bazelTargetQuery,
      targetScope: options.bazelTargetScope,
      scopeConfigHash: options.runConfigHash,
      concurrency: options.bazelPreparationConcurrency,
      timeoutMs: options.bazelPreparationTimeoutMs,
    },
  );
  logBuildRootPreparation(preparedBuildRoots.roots);
  enforceBuildRootPolicy(options, preparedBuildRoots.roots);

  const filesByRoot = addConfiguredJavaSources(
    assignFilesToBuildRoots(repositoryJavaFiles, discoveredRoots),
    preparedBuildRoots.roots,
  );
  for (const result of preparedBuildRoots.roots) {
    if (result.crawlSources) {
      logSourceInventory(
        result.rootId,
        result.crawlSources,
        result.sourceInventoryComparison,
        result.sourceInventoryPath,
      );
    }
  }

  const preparationByRoot = new Map(
    preparedBuildRoots.roots.map((result) => [result.rootId, result]),
  );
  const activeRoots = discoveredRoots.filter((root) =>
    (filesByRoot.get(root.id)?.length ?? 0) > 0
    || preparationByRoot.get(root.id)?.status === 'failed');
  if (activeRoots.length === 0) console.log('[stage:lsp-crawl] no Java semantic partitions');

  const javaFiles = [...new Set([...filesByRoot.values()].flat())].sort();
  const registeredSemanticFiles = discoverRegisteredSemanticSources(workspacePath, adapterRegistry);
  const checkpointStore = new PipelineCheckpointStore(options.checkpointDirectory, options.resume);
  const crawlFingerprint = fingerprintPipelineInputs(
    workspacePath,
    collectCrawlInputPaths(
      workspacePath,
      javaFiles,
      options.artifactManifestPaths,
      registeredSemanticFiles,
    ),
    {
      stageVersion: 8,
      buildRoots: activeRoots.map(({ id, relativePath, systems }) => ({ id, relativePath, systems })),
      artifactManifestPaths: options.artifactManifestPaths.map((value) => path.resolve(value)),
      crawlProfile: options.crawlProfile,
      javaSemantics: options.javaSemantics,
      bazelBuildMode: options.bazelBuildMode,
      bazelTargetQuery: options.bazelTargetQuery ?? null,
      runConfigHash: options.runConfigHash ?? null,
      repositoryInventoryFingerprint: hashRepositoryInventory(repositoryInventory),
      semanticAdapterCatalog: adapterRegistry.getAdapterCatalog(),
    },
  );
  console.log(`[stage:lsp-crawl] cache ID ${crawlFingerprint}`);

  return {
    workspacePath,
    repositoryInventory,
    preparation: preparedBuildRoots.roots,
    activeRoots,
    filesByRoot,
    registeredSemanticFiles,
    checkpointStore,
    crawlFingerprint,
  };
}

function enforceBuildRootPolicy(
  options: LspKnowledgeGraphBuildOptions,
  preparations: readonly JavaBuildRootPreparation[],
): void {
  if (!options.failOnFailedBuildRoot) return;
  const failed = preparations.filter((root) => root.status === 'failed');
  if (failed.length > 0) {
    throw new Error(`Bazel preparation failed for ${failed.length}/${preparations.length} roots`);
  }
}

function assignFilesToBuildRoots(
  javaFiles: readonly string[],
  buildRoots: JavaBuildRoot[],
): Map<string, string[]> {
  const filesByRoot = new Map<string, string[]>();
  for (const file of javaFiles) {
    const root = ownerBuildRoot(file, buildRoots);
    if (!root) continue;
    const files = filesByRoot.get(root.id) ?? [];
    files.push(file);
    filesByRoot.set(root.id, files);
  }
  return filesByRoot;
}

function collectCrawlInputPaths(
  workspacePath: string,
  javaFiles: readonly string[],
  artifactManifestPaths: readonly string[],
  semanticSourcePaths: readonly string[],
): string[] {
  const buildFiles = globSync([
    '**/BUILD', '**/BUILD.bazel', '**/WORKSPACE', '**/WORKSPACE.bazel', '**/MODULE.bazel',
    '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/settings.gradle',
    '**/settings.gradle.kts', '**/gradle.properties', '**/.gitnexus/jdtls/bazel-project.json',
    '**/.gitnexus/jdtls/bazel-source-inventory.json', '**/.gitnexus/jdtls/bazel-handoff.json',
  ], {
    cwd: workspacePath,
    absolute: true,
    nodir: true,
    ignore: ['**/.git/**', '**/node_modules/**', '**/target/**', '**/build/**', '**/bazel-*/**'],
  });
  const batchExtension = path.resolve(
    process.cwd(), 'dist/jdt-batch-extension/gitnexus-jdt-batch-extension.jar',
  );
  return [...new Set([
    ...javaFiles,
    ...semanticSourcePaths,
    ...buildFiles,
    ...artifactManifestPaths.map((value) => path.resolve(value)),
    ...(fs.existsSync(batchExtension) ? [batchExtension] : []),
  ])].sort();
}

function hashRepositoryInventory(inventory: RepositoryInventoryBatch): string {
  const hash = createHash('sha256');
  for (const provider of inventory.providers) {
    hash.update(provider.providerId).update('\0').update(provider.providerVersion).update('\0');
    for (const pattern of provider.includeGlobs) hash.update(pattern).update('\0');
  }
  for (const document of inventory.documents) {
    hash.update(document.relativePath).update('\0').update(document.contentHash).update('\0');
    hash.update(document.providerId).update('\0').update(document.providerVersion).update('\0');
  }
  return hash.digest('hex');
}

function logBuildRootPreparation(
  preparations: ReadonlyArray<{
    rootId: string;
    status: string;
    classpathEntries?: number;
    reason?: string;
  }>,
): void {
  for (const preparation of preparations) {
    const detail = preparation.classpathEntries !== undefined
      ? `${preparation.classpathEntries} classpath entries`
      : preparation.reason ?? 'no detail';
    console.log(`[${preparation.rootId}] Bazel model ${preparation.status}: ${detail}`);
  }
}

function logSourceInventory(
  rootId: string,
  sources: NonNullable<JavaBuildRootPreparation['crawlSources']>,
  comparison?: JavaBuildRootPreparation['sourceInventoryComparison'],
  inventoryPath?: string,
): void {
  const repository = sources.filter((source) => source.origin === 'repository').length;
  const generated = sources.filter((source) => source.origin === 'generated').length;
  const sourceJarOnly = sources.filter((source) => source.origin === 'source_jar').length;
  console.log(
    `[${rootId}] Bazel sources: repository=${repository}, `
    + `configured=${comparison?.configuredRepositorySources ?? 0}, generated=${generated}, `
    + `source-jar-only=${sourceJarOnly}, unowned=${comparison?.unownedRepositorySources.length ?? 0}, `
    + `deduplicated=${comparison?.duplicateSources ?? 0}, crawl=${sources.length}`
    + (inventoryPath ? ` (${inventoryPath})` : ''),
  );
}
