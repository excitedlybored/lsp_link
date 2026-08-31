/** Application-level orchestration for the Java knowledge-graph pipeline. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import type { LspObservationBatch } from '../ingest/batch.js';
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
} from '../pipeline/types.js';
import { ownerBuildRoot, type JavaBuildRoot } from '../../../lsp_server/adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../../../lsp_server/registry/lsp-adapter-registry.js';
import { buildBazelBuildGraphBatch } from '../bazel/model.js';

export async function buildLspKnowledgeGraph(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspKnowledgeGraphBuildResult> {
  const workspacePath = path.resolve(options.workspace);
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
  if (activeRoots.length === 0) {
    throw new Error(`No repository or configured Java sources found under ${workspacePath}`);
  }
  const javaFiles = [...new Set([...filesByRoot.values()].flat())].sort();

  const checkpointStore = new PipelineCheckpointStore(options.checkpointDirectory, options.resume);
  const crawlFingerprint = fingerprintPipelineInputs(
    workspacePath,
    collectCrawlInputPaths(workspacePath, javaFiles, options.artifactManifestPaths),
    {
      // Increment whenever crawl semantics change so a checkpoint cannot hide
      // a newly fixed or newly collected LSP observation.
      stageVersion: 5,
      buildRoots: activeRoots.map(({ id, relativePath, systems }) => ({ id, relativePath, systems })),
      artifactManifestPaths: options.artifactManifestPaths.map((value) => path.resolve(value)),
      crawlPlanner: options.crawlPlanner,
      crawlProfile: options.crawlProfile,
      bazelBuildMode: options.bazelBuildMode,
      bazelTargetQuery: options.bazelTargetQuery ?? null,
      runConfigHash: options.runConfigHash ?? null,
    },
  );
  const normalizationFingerprint = combineCheckpointFingerprint(
    'call-normalization-v1', crawlFingerprint,
  );
  const completedCrawl = checkpointStore.load<JavaCrawlCheckpoint>('lsp-crawl', crawlFingerprint);
  let lspBatch: LspObservationBatch;
  let artifacts: NormalizedArtifactDescriptor[];
  let classpathAttempts: ArtifactClasspathProviderAttempt[];

  try {
    if (completedCrawl) {
      ({ lspBatch, artifacts, classpathAttempts } = completedCrawl);
    } else {
      const crawl = await crawlJavaWorkspace({
        options,
        adapterRegistry,
        workspacePath,
        activeRoots,
        filesByRoot,
        preparations: preparation.roots,
        checkpointStore,
        crawlFingerprint,
      });
      ({ lspBatch, artifacts, classpathAttempts } = crawl);
      checkpointStore.save<JavaCrawlCheckpoint>('lsp-crawl', crawlFingerprint, crawl);
    }
    if (options.failOnFailedBuildRoot && lspBatch.servers.some((server) => server.status === 'failed')) {
      throw new Error('Semantic crawl failed for one or more build roots');
    }

    let callNormalizationBatch = checkpointStore.load<DerivedCallNormalizationBatch>(
      'call-normalization', normalizationFingerprint,
    );
    if (!callNormalizationBatch) {
      console.log('[stage:call-normalization] deriving logical invocations from LSP call observations');
      callNormalizationBatch = normalizeLogicalCalls(lspBatch);
      logCallNormalization(callNormalizationBatch);
      checkpointStore.save('call-normalization', normalizationFingerprint, callNormalizationBatch);
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
    );
    logArtifactEnrichment(persisted.artifactEnrichment);
    return {
      batch: lspBatch,
      callNormalizationBatch,
      artifactEnrichment: persisted.artifactEnrichment,
      output: persisted.output,
      bazelBuildGraph,
    };
  } finally {
    await adapterRegistry.shutdownAll();
  }
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
  return [...javaFiles, ...buildFiles, ...artifactManifestPaths];
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
