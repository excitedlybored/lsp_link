/** Application-level orchestration for structural, semantic, build, and artifact evidence. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import lbug from '@ladybugdb/core';
import { globSync } from 'glob';
import type {
  ArtifactClasspathProviderAttempt,
  NormalizedArtifactDescriptor,
} from '../artifact/classpath/index.js';
import { crawlJavaWorkspace, type JavaCrawlCheckpoint } from './java-crawl-stage.js';
import { persistStreamingKnowledgeGraph } from '../artifact/streaming-persistence.js';
import { normalizeLogicalCalls } from '../derived/call-normalization/normalize.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import {
  dedupeObservationBatch,
  emptyObservationBatch,
  mergeObservationBatches,
  type LspObservationBatch,
} from '../ingest/batch.js';
import type { LadybugModuleLike } from '../lbug/repository.js';
import {
  combineCheckpointFingerprint,
  fingerprintPipelineInputs,
  PipelineCheckpointStore,
} from '../pipeline/checkpoints.js';
import { addConfiguredJavaSources, findJavaSourceFiles } from '../pipeline/java-source-files.js';
import type {
  JavaBuildRootPreparation,
  LspKnowledgeGraphBuildOptions,
  LspKnowledgeGraphBuildResult,
  LspRepositoryCrawlResult,
} from '../pipeline/types.js';
import { LspAdapterRegistry, ownerBuildRoot, type JavaBuildRoot } from '../../../lsp_server/public-api.js';
import { buildBazelBuildGraphBatch } from '../bazel/model.js';
import { buildRepositoryInventory } from '../repository/inventory.js';
import type { RepositoryInventoryBatch } from '../repository/model.js';
import {
  crawlRegisteredRepositoryLanguages,
  discoverRegisteredSemanticSources,
} from './polyglot-crawl-stage.js';
import { startMemoryTelemetry } from '../telemetry/memory.js';

export async function buildLspKnowledgeGraph(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspKnowledgeGraphBuildResult> {
  return runLspPipeline(options, adapterRegistry, false) as Promise<LspKnowledgeGraphBuildResult>;
}

export async function crawlLspRepository(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspRepositoryCrawlResult> {
  return runLspPipeline(options, adapterRegistry, true) as Promise<LspRepositoryCrawlResult>;
}

async function runLspPipeline(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
  crawlOnly: boolean,
): Promise<LspKnowledgeGraphBuildResult | LspRepositoryCrawlResult> {
  const pipelineStartedAt = Date.now();
  let peakNodeRssBytes = process.memoryUsage.rss();
  const rssSampler = setInterval(() => {
    peakNodeRssBytes = Math.max(peakNodeRssBytes, process.memoryUsage.rss());
  }, 250);
  rssSampler.unref();
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
  const preparation = await adapterRegistry.prepareJavaBuildRoots(
    workspacePath,
    undefined,
    {
      buildMode: options.bazelBuildMode, targetQuery: options.bazelTargetQuery,
      targetScope: options.bazelTargetScope, scopeConfigHash: options.runConfigHash,
      concurrency: options.bazelPreparationConcurrency, timeoutMs: options.bazelPreparationTimeoutMs,
    },
  );
  logBuildRootPreparation(preparation.roots);
  if (options.failOnFailedBuildRoot) {
    const failed = preparation.roots.filter((root) => root.status === 'failed');
    if (failed.length > 0) throw new Error(`Bazel preparation failed for ${failed.length}/${preparation.roots.length} roots`);
  }
  const filesByRoot = addConfiguredJavaSources(
    assignFilesToBuildRoots(repositoryJavaFiles, discoveredRoots),
    preparation.roots,
  );
  for (const result of preparation.roots) {
    if (result.crawlSources) logSourceInventory(
      result.rootId,
      result.crawlSources,
      result.sourceInventoryComparison,
      result.sourceInventoryPath,
    );
  }
  const preparationByRoot = new Map(preparation.roots.map((result) => [result.rootId, result]));
  const activeRoots = discoveredRoots.filter((root) =>
    (filesByRoot.get(root.id)?.length ?? 0) > 0 || preparationByRoot.get(root.id)?.status === 'failed'
  );
  if (activeRoots.length === 0) console.log('[stage:lsp-crawl] no Java semantic partitions');
  const javaFiles = [...new Set([...filesByRoot.values()].flat())].sort();
  const registeredSemanticFiles = discoverRegisteredSemanticSources(workspacePath, adapterRegistry);

  const checkpointStore = new PipelineCheckpointStore(options.checkpointDirectory, options.resume);
  const crawlFingerprint = fingerprintPipelineInputs(
    workspacePath,
    collectCrawlInputPaths(
      workspacePath, javaFiles, options.artifactManifestPaths, registeredSemanticFiles,
    ),
    {
      // Increment whenever crawl semantics change so a checkpoint cannot hide
      // a newly fixed or newly collected LSP observation.
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
  const normalizationFingerprint = combineCheckpointFingerprint(
    'call-normalization-v1', crawlFingerprint,
  );
  console.log(`[stage:lsp-crawl] cache ID ${crawlFingerprint}`);
  const cacheTelemetry = startMemoryTelemetry('crawl-cache-loading', {
    cache: 'lsp-crawl', cacheId: crawlFingerprint,
  });
  const completedCrawl = checkpointStore.loadCached<JavaCrawlCheckpoint>('lsp-crawl', crawlFingerprint);
  cacheTelemetry.end();
  let lspBatch: LspObservationBatch;
  let artifacts: NormalizedArtifactDescriptor[];
  let classpathAttempts: ArtifactClasspathProviderAttempt[];

  try {
    if (completedCrawl) {
      ({ lspBatch, artifacts, classpathAttempts } = completedCrawl);
    } else {
      const crawl = activeRoots.length > 0
        ? await crawlJavaWorkspace({
          options,
          adapterRegistry,
          workspacePath,
          activeRoots,
          filesByRoot,
          preparations: preparation.roots,
          checkpointStore,
          crawlFingerprint,
        })
        : emptySemanticCrawl(workspacePath, crawlFingerprint);
      const run = crawl.lspBatch.analysisRuns[0]!;
      const polyglotBatch = await crawlRegisteredRepositoryLanguages({
        workspacePath,
        run,
        repositoryInventory,
        adapterRegistry,
        profile: options.crawlProfile,
        semanticSourcePaths: registeredSemanticFiles,
      });
      crawl.lspBatch = dedupeObservationBatch(mergeObservationBatches(crawl.lspBatch, polyglotBatch));
      ({ lspBatch, artifacts, classpathAttempts } = crawl);
      if (!(crawlOnly && hasIncompleteBatchJavaServer(lspBatch, options.javaSemantics))) {
        checkpointStore.saveCached<JavaCrawlCheckpoint>('lsp-crawl', crawlFingerprint, crawl);
      }
    }
    if (options.failOnFailedBuildRoot && lspBatch.servers.some((server) => server.status === 'failed')) {
      throw new Error('Semantic crawl failed for one or more build roots');
    }
    if (crawlOnly) {
      if (hasIncompleteBatchJavaServer(lspBatch, options.javaSemantics)) {
        throw new Error('Crawl-only validation requires every JDT batch server to complete');
      }
      checkpointStore.save('lsp-crawl', crawlFingerprint, {
        lspBatch, artifacts, classpathAttempts,
      } satisfies JavaCrawlCheckpoint);
      return {
        batch: lspBatch,
        artifacts,
        classpathAttempts,
        checkpoint: path.join(options.checkpointDirectory, 'lsp-crawl.checkpoint'),
        crawlFingerprint,
        durationMs: Date.now() - pipelineStartedAt,
        peakNodeRssMiB: Math.round(peakNodeRssBytes / 1024 / 1024 * 100) / 100,
        repositoryInventory,
      };
    }

    let callNormalizationBatch = checkpointStore.loadCached<DerivedCallNormalizationBatch>(
      'call-normalization', normalizationFingerprint,
    );
    if (!callNormalizationBatch) {
      console.log('[stage:call-normalization] deriving logical invocations from LSP call observations');
      callNormalizationBatch = normalizeLogicalCalls(lspBatch);
      logCallNormalization(callNormalizationBatch);
      checkpointStore.saveCached('call-normalization', normalizationFingerprint, callNormalizationBatch);
    }

    console.log('[stage:jvm-artifact-enrichment] streaming ASM artifact facts');
    const artifactFingerprint = combineCheckpointFingerprint(
      'jvm-artifact-enrichment-asm-stream-v2-bazel-graph', crawlFingerprint,
      options.artifactMaxClasses ?? null,
      options.fetchArtifactSources,
      artifacts.map((artifact) => ({
        classpathEntryPath: artifact.classpathEntryPath,
        headerJarPath: artifact.headerJarPath,
        binaryJarPath: artifact.binaryJarPath,
        contentHash: hashArtifactDescriptor(artifact),
      })),
    );
    const bazelBuildGraph = buildBazelBuildGraphBatch(preparation.roots);
    console.log(
      `[stage:bazel-build-graph] ${bazelBuildGraph.targets.length} targets, `
      + `${bazelBuildGraph.sources.length} sources, ${bazelBuildGraph.artifacts.length} artifacts, `
      + `${bazelBuildGraph.relations.length} relations`,
    );
    const persisted = await persistStreamingKnowledgeGraph(
      options.output,
      artifactFingerprint,
      checkpointStore,
      lspBatch,
      callNormalizationBatch,
      {
        lspRunId: lspBatch.analysisRuns[0]!.id,
        artifacts,
        classpathAttempts,
        cacheDirectory: path.join(workspacePath, '.gitnexus', 'jvm-artifacts'),
        lspBatch,
        maxDisassembledClasses: options.artifactMaxClasses,
        workerConcurrency: options.artifactConcurrency,
        fetchSources: options.fetchArtifactSources,
      },
      lbug as unknown as LadybugModuleLike,
      options.resume,
      bazelBuildGraph,
      repositoryInventory,
    );
    logArtifactEnrichment(persisted.artifactEnrichment);
    return {
      batch: lspBatch,
      callNormalizationBatch,
      artifactEnrichment: persisted.artifactEnrichment,
      output: persisted.output,
      bazelBuildGraph,
      repositoryInventory,
    };
  } finally {
    clearInterval(rssSampler);
    await adapterRegistry.shutdownAll();
  }
}

function hasIncompleteBatchJavaServer(batch: LspObservationBatch, javaSemantics: string): boolean {
  return javaSemantics === 'batch' && batch.servers.some((server) =>
    server.languageId === 'java' && server.name.startsWith('JDT Language Server') && server.status !== 'complete');
}

function emptySemanticCrawl(workspacePath: string, fingerprint: string): JavaCrawlCheckpoint {
  const batch = emptyObservationBatch();
  const startedAt = new Date().toISOString();
  batch.analysisRuns.push({
    id: `run:${fingerprint}`,
    workspaceUri: pathToFileURL(workspacePath).href,
    repositoryPath: workspacePath,
    protocolVersion: '3.18',
    positionEncoding: 'utf-16',
    status: 'complete',
    startedAt,
    completedAt: startedAt,
    requestedLanguages: [],
    errorCount: 0,
    timeoutCount: 0,
  });
  return { lspBatch: batch, artifacts: [], classpathAttempts: [] };
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

function hashArtifactDescriptor(artifact: NormalizedArtifactDescriptor): string {
  const selected = artifact.binaryJarPath ?? artifact.headerJarPath ?? artifact.classpathEntryPath;
  const hash = createHash('sha256');
  hash.update(path.resolve(selected));
  try { hash.update(fs.readFileSync(selected)); }
  catch (error) { hash.update(`unreadable:${error instanceof Error ? error.message : String(error)}`); }
  return hash.digest('hex');
}

function collectCrawlInputPaths(
  workspacePath: string,
  javaFiles: string[],
  artifactManifestPaths: string[],
  semanticSourcePaths: string[] = [],
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
  const batchExtension = path.resolve(process.cwd(), 'dist/jdt-batch-extension/gitnexus-jdt-batch-extension.jar');
  return [...new Set([
    ...javaFiles,
    ...semanticSourcePaths,
    ...buildFiles,
    ...artifactManifestPaths.map((value) => path.resolve(value)),
    ...(fs.existsSync(batchExtension) ? [batchExtension] : []),
  ])].sort();
}

function assignFilesToBuildRoots(
  javaFiles: string[],
  buildRoots: JavaBuildRoot[],
): Map<string, string[]> {
  const filesByRoot = new Map<string, string[]>();
  for (const file of javaFiles) {
    const root = ownerBuildRoot(file, buildRoots);
    if (!root) continue;
    const rootFiles = filesByRoot.get(root.id) ?? [];
    rootFiles.push(file);
    filesByRoot.set(root.id, rootFiles);
  }
  return filesByRoot;
}

function logBuildRootPreparation(
  preparations: Array<{ rootId: string; status: string; classpathEntries?: number; reason?: string }>,
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

function logArtifactEnrichment(summary: LspKnowledgeGraphBuildResult['artifactEnrichment']): void {
  const run = summary.run;
  console.log(
    `[stage:jvm-artifact-enrichment] ${run.status}: ${run.artifactCount} artifacts, `
    + `${run.classCount} classes, ${run.methodCount} methods, ${run.callSiteCount} bytecode calls, `
    + `${summary.sourceAssociatedArtifactCount} source-associated artifacts`,
  );
}

function logCallNormalization(
  batch: LspKnowledgeGraphBuildResult['callNormalizationBatch'],
): void {
  const run = batch.runs[0]!;
  console.log(
    `[stage:call-normalization] ${run.status}: ${run.observationCount} observations -> `
    + `${run.invocationCount} logical invocations `
    + `(${run.ambiguousObservationCount} ambiguous observations)`,
  );
}
