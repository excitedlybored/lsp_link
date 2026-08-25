/**
 * CLI entry point and top-level orchestration for the Java/JDT-LS knowledge graph.
 * Every persisted observation originates from an LSP response or artifact stage.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import lbug from '@ladybugdb/core';
import { globSync } from 'glob';
import {
  ArtifactClasspathResolver,
  retainArtifactClasspathEntries,
  type ArtifactClasspathProviderAttempt,
  type NormalizedArtifactDescriptor,
} from '../artifact/classpath/index.js';
import type { JvmArtifactBatch } from '../artifact/model.js';
import { enrichJvmArtifacts } from '../artifact/enrichment.js';
import { normalizeLogicalCalls } from '../derived/call-normalization/normalize.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import { dedupeObservationBatch, mergeObservationBatches } from '../ingest/batch.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import { openLspLadybugDatabase, type LadybugModuleLike } from '../lbug/repository.js';
import type { LspAnalysisRun } from '../model.js';
import { parseLspKnowledgeGraphBuildOptions } from '../pipeline/cli-options.js';
import {
  combineCheckpointFingerprint,
  fingerprintPipelineInputs,
  PipelineCheckpointStore,
} from '../pipeline/checkpoints.js';
import { mapConcurrently } from '../pipeline/concurrency.js';
import { crawlJavaBuildRoot } from '../pipeline/java-build-root-crawler.js';
import { findJavaSourceFiles } from '../pipeline/java-source-files.js';
import type {
  JavaBuildRootCrawlResult,
  LspKnowledgeGraphBuildOptions,
  LspKnowledgeGraphBuildResult,
} from '../pipeline/types.js';
import { ownerBuildRoot, type JavaBuildRoot } from '../../../lsp_server/adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../../../lsp_server/registry/lsp-adapter-registry.js';
import {
  planJdtlsBuildRootShards,
  prepareJdtlsShardWorkspace,
} from '../../../lsp_server/adapters/java/jdtls-sharding.js';

export async function buildLspKnowledgeGraph(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspKnowledgeGraphBuildResult> {
  const workspacePath = path.resolve(options.workspace);
  const javaFiles = findJavaSourceFiles(workspacePath);
  if (javaFiles.length === 0) throw new Error(`No Java files found under ${workspacePath}`);

  const discoveredRoots = adapterRegistry.getJavaBuildRoots(workspacePath);
  const filesByRoot = assignFilesToBuildRoots(javaFiles, discoveredRoots);
  const activeRoots = discoveredRoots.filter((root) => (filesByRoot.get(root.id)?.length ?? 0) > 0);
  if (activeRoots.length === 0) {
    throw new Error('Java files were found but none belongs to a discovered build root');
  }

  const checkpointStore = new PipelineCheckpointStore(options.checkpointDirectory, options.resume);
  const crawlFingerprint = fingerprintPipelineInputs(
    workspacePath,
    collectCrawlInputPaths(workspacePath, javaFiles, options.artifactManifestPaths),
    {
      stageVersion: 1,
      buildRoots: activeRoots.map(({ id, relativePath, systems }) => ({ id, relativePath, systems })),
      artifactManifestPaths: options.artifactManifestPaths.map((value) => path.resolve(value)),
    },
  );
  const normalizationFingerprint = combineCheckpointFingerprint(
    'call-normalization-v1', crawlFingerprint,
  );
  const artifactFingerprint = combineCheckpointFingerprint(
    'jvm-artifact-enrichment-v1', crawlFingerprint,
    options.artifactMaxClasses ?? null,
    options.fetchArtifactSources,
  );

  const completedCrawl = checkpointStore.load<LspCrawlCheckpoint>('lsp-crawl', crawlFingerprint);
  let lspBatch: LspObservationBatch;
  let artifacts: NormalizedArtifactDescriptor[];
  let classpathAttempts: ArtifactClasspathProviderAttempt[];

  try {
    if (completedCrawl) {
      ({ lspBatch, artifacts, classpathAttempts } = completedCrawl);
    } else {
      const crawl = await crawlWorkspace(
        options, adapterRegistry, workspacePath, activeRoots, filesByRoot, checkpointStore,
        crawlFingerprint,
      );
      ({ lspBatch, artifacts, classpathAttempts } = crawl);
      checkpointStore.save<LspCrawlCheckpoint>('lsp-crawl', crawlFingerprint, crawl);
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

    let artifactBatch = checkpointStore.load<JvmArtifactBatch>(
      'jvm-artifact-enrichment', artifactFingerprint,
    );
    if (!artifactBatch) {
      console.log('[stage:jvm-artifact-enrichment] associating header, binary, and source JARs');
      artifactBatch = await enrichJvmArtifacts({
        lspRunId: lspBatch.analysisRuns[0]!.id,
        artifacts,
        classpathAttempts,
        cacheDirectory: path.join(workspacePath, '.gitnexus', 'jvm-artifacts'),
        lspBatch,
        maxDisassembledClasses: options.artifactMaxClasses,
        javapConcurrency: options.artifactConcurrency,
        fetchSources: options.fetchArtifactSources,
      });
      logArtifactEnrichment(artifactBatch);
      checkpointStore.save('jvm-artifact-enrichment', artifactFingerprint, artifactBatch);
    }

    const outputPath = await persistKnowledgeGraph(
      options.output, lspBatch, callNormalizationBatch, artifactBatch,
    );
    return { batch: lspBatch, callNormalizationBatch, artifactBatch, output: outputPath };
  } finally {
    await adapterRegistry.shutdownAll();
  }
}

interface LspCrawlCheckpoint {
  lspBatch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  classpathAttempts: ArtifactClasspathProviderAttempt[];
}

async function crawlWorkspace(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
  workspacePath: string,
  activeRoots: JavaBuildRoot[],
  filesByRoot: Map<string, string[]>,
  checkpointStore: PipelineCheckpointStore,
  crawlFingerprint: string,
): Promise<LspCrawlCheckpoint> {
  console.log(
    `[stage:lsp-crawl] preparing ${activeRoots.length} Java build roots `
    + `(concurrency=${options.concurrency})`,
  );
  // A stable run id lets independently checkpointed roots reconnect to the
  // same analysis run when an interrupted crawl resumes.
  const run = createAnalysisRun(workspacePath, `run:${crawlFingerprint}`);
  const artifactClasspathResolver = new ArtifactClasspathResolver();
  const cachedByRoot = new Map<string, JavaBuildRootCrawlResult>();
  for (const root of activeRoots) {
    const cached = checkpointStore.load<JavaBuildRootCrawlResult>(
      checkpointStore.rootStage(root.id), crawlFingerprint,
    );
    if (cached) cachedByRoot.set(root.id, cached);
  }
  let completedRootCount = cachedByRoot.size;
  if (completedRootCount > 0) {
    console.log(`[stage:lsp-crawl] ${completedRootCount}/${activeRoots.length} roots restored`);
  }
  if (completedRootCount === activeRoots.length) {
    return assembleCrawlCheckpoint(run, [...cachedByRoot.values()]);
  }

  const preparation = await adapterRegistry.prepareJavaBuildRoots(
    workspacePath, activeRoots.map((root) => root.id),
  );
  logBuildRootPreparation(preparation.roots);
  const preparationsByRoot = new Map(preparation.roots.map((result) => [result.rootId, result]));
  const shardPlans = planJdtlsBuildRootShards(activeRoots, options.concurrency)
    .filter((plan) => plan.roots.some((root) => !cachedByRoot.has(root.id)));
  console.log(
    `[stage:lsp-crawl] starting ${shardPlans.length} persistent JDT LS shards: `
    + shardPlans.map((shard) => `${shard.id}=${shard.roots.length} roots/${shard.sourceFileCount} files`).join(', '),
  );
  const shardResults = await mapConcurrently(shardPlans, Math.max(1, shardPlans.length), async (shardPlan) => {
    const pendingRoots = shardPlan.roots.filter((root) => !cachedByRoot.has(root.id));
    const shard = prepareJdtlsShardWorkspace(workspacePath, { ...shardPlan, roots: pendingRoots });
    const adapter = await adapterRegistry.getOrStartJavaShard(shard);
    const results: JavaBuildRootCrawlResult[] = [];
    try {
      for (const root of pendingRoots) {
        const files = filesByRoot.get(root.id) ?? [];
        console.log(`[${root.id}] crawling ${files.length} files on ${shard.id}`);
        const result = await crawlJavaBuildRoot(
          adapterRegistry,
          artifactClasspathResolver,
          workspacePath,
          run,
          root,
          files,
          preparationsByRoot.get(root.id),
          options.artifactManifestPaths,
          adapter ?? undefined,
          shard.id,
          true,
        );
        result.artifacts = retainArtifactClasspathEntries(
          result.artifacts,
          path.join(workspacePath, '.gitnexus', 'jvm-artifacts', 'classpath'),
        );
        checkpointStore.save(checkpointStore.rootStage(root.id), crawlFingerprint, result);
        completedRootCount += 1;
        console.log(`[${root.id}] complete (${completedRootCount}/${activeRoots.length})`);
        results.push(result);
      }
      return results;
    } finally {
      if (adapter) await adapterRegistry.shutdownAdapter(adapter);
    }
  });
  const rootResults = [
    ...activeRoots.flatMap((root) => {
      const cached = cachedByRoot.get(root.id);
      return cached ? [cached] : [];
    }),
    ...shardResults.flat(),
  ];
  if (rootResults.length !== activeRoots.length) {
    throw new Error(`Expected ${activeRoots.length} root results, received ${rootResults.length}`);
  }

  return assembleCrawlCheckpoint(run, rootResults);
}

function assembleCrawlCheckpoint(
  run: LspAnalysisRun,
  rootResults: JavaBuildRootCrawlResult[],
): LspCrawlCheckpoint {
  finalizeAnalysisRun(run, rootResults);
  const lspBatch = dedupeObservationBatch(mergeObservationBatches(
    ...rootResults.map((result) => result.batch),
  ));
  lspBatch.analysisRuns.splice(0, lspBatch.analysisRuns.length, run);
  return {
    lspBatch,
    artifacts: rootResults.flatMap((result) => result.artifacts),
    classpathAttempts: rootResults.flatMap((result) => result.artifactClasspathAttempts),
  };
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

function createAnalysisRun(workspacePath: string, id?: string): LspAnalysisRun {
  const startedAt = new Date().toISOString();
  return {
    id: id ?? `run:${startedAt}:${randomUUID()}`,
    workspaceUri: pathToFileURL(workspacePath).href,
    repositoryPath: workspacePath,
    protocolVersion: '3.18',
    positionEncoding: 'utf-16',
    status: 'partial',
    startedAt,
    requestedLanguages: ['java'],
    errorCount: 0,
    timeoutCount: 0,
  };
}

function finalizeAnalysisRun(
  run: LspAnalysisRun,
  results: Array<{ failed: boolean; errorCount: number; timeoutCount: number }>,
): void {
  run.errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
  run.timeoutCount = results.reduce((sum, result) => sum + result.timeoutCount, 0);
  run.status = results.some((result) => result.failed) || run.errorCount > 0 || run.timeoutCount > 0
    ? 'partial'
    : 'complete';
  run.completedAt = new Date().toISOString();
}

async function persistKnowledgeGraph(
  requestedOutputPath: string,
  lspBatch: LspKnowledgeGraphBuildResult['batch'],
  callNormalizationBatch: LspKnowledgeGraphBuildResult['callNormalizationBatch'],
  artifactBatch: LspKnowledgeGraphBuildResult['artifactBatch'],
): Promise<string> {
  const outputPath = path.resolve(requestedOutputPath);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing LSP database: ${outputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const handle = openLspLadybugDatabase(outputPath, lbug as unknown as LadybugModuleLike);
  try {
    await handle.repository.initializeSchema();
    await handle.repository.writeBatch(lspBatch);
    await handle.callNormalizationRepository.initializeSchema();
    await handle.callNormalizationRepository.writeBatch(callNormalizationBatch);
    await handle.artifactRepository.initializeSchema();
    await handle.artifactRepository.writeBatch(artifactBatch);
  } finally {
    await handle.close();
  }
  return outputPath;
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

function logArtifactEnrichment(artifactBatch: LspKnowledgeGraphBuildResult['artifactBatch']): void {
  const run = artifactBatch.runs[0];
  const sourceAssociatedArtifacts = artifactBatch.artifacts
    .filter((artifact) => artifact.associationStatus === 'complete').length;
  console.log(
    `[stage:jvm-artifact-enrichment] ${run.status}: ${run.artifactCount} artifacts, `
    + `${run.classCount} classes, ${run.methodCount} methods, ${run.callSiteCount} bytecode calls, `
    + `${sourceAssociatedArtifacts} source-associated artifacts`,
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

async function main(): Promise<void> {
  const options = parseLspKnowledgeGraphBuildOptions(process.argv.slice(2));
  const { batch, callNormalizationBatch, artifactBatch, output } =
    await buildLspKnowledgeGraph(options);
  console.log(JSON.stringify({
    output,
    run: batch.analysisRuns[0],
    buildRoots: batch.buildRoots.length,
    servers: batch.servers.length,
    documents: batch.documents.length,
    symbols: batch.symbols.length,
    callSites: batch.callSites.length,
    occurrences: batch.occurrences.length,
    diagnostics: batch.diagnostics.length,
    semanticTokens: batch.semanticTokens.length,
    coverage: batch.coverage.length,
    relations: batch.relations.length,
    callNormalization: callNormalizationBatch.runs[0],
    artifactEnrichment: artifactBatch.runs[0],
  }, null, 2));
}

if (process.argv[1]?.endsWith('/build.ts') || process.argv[1]?.endsWith('\\build.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
