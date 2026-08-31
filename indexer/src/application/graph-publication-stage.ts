import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import lbug from '@ladybugdb/core';

import type { NormalizedArtifactDescriptor } from '../artifact/classpath/index.js';
import { persistStreamingKnowledgeGraph } from '../artifact/streaming-persistence.js';
import { buildBazelBuildGraphBatch } from '../bazel/model.js';
import { normalizeLogicalCalls } from '../derived/call-normalization/normalize.js';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type { LadybugModuleLike } from '../lbug/repository.js';
import { combineCheckpointFingerprint } from '../pipeline/checkpoints.js';
import type {
  LspKnowledgeGraphBuildOptions,
  LspKnowledgeGraphBuildResult,
} from '../pipeline/types.js';
import type { JavaCrawlCheckpoint } from './java-crawl-stage.js';
import type { PreparedPipeline } from './pipeline-preparation-stage.js';

export interface GraphPublicationRequest {
  readonly options: LspKnowledgeGraphBuildOptions;
  readonly pipeline: PreparedPipeline;
  readonly crawl: JavaCrawlCheckpoint;
  readonly ladybug?: LadybugModuleLike;
}

/** Derives logical calls, enriches JVM artifacts, and atomically publishes the graph. */
export async function publishKnowledgeGraph(
  request: GraphPublicationRequest,
): Promise<LspKnowledgeGraphBuildResult> {
  const { options, pipeline, crawl } = request;
  const callNormalizationBatch = deriveLogicalCalls(request);

  console.log('[stage:jvm-artifact-enrichment] streaming ASM artifact facts');
  const artifactFingerprint = fingerprintArtifactStage(
    options,
    pipeline.crawlFingerprint,
    crawl.artifacts,
  );
  const bazelBuildGraph = buildBazelBuildGraphBatch([...pipeline.preparation]);
  console.log(
    `[stage:bazel-build-graph] ${bazelBuildGraph.targets.length} targets, `
    + `${bazelBuildGraph.sources.length} sources, ${bazelBuildGraph.artifacts.length} artifacts, `
    + `${bazelBuildGraph.relations.length} relations`,
  );
  const persisted = await persistStreamingKnowledgeGraph(
    options.output,
    artifactFingerprint,
    pipeline.checkpointStore,
    crawl.lspBatch,
    callNormalizationBatch,
    {
      lspRunId: crawl.lspBatch.analysisRuns[0]!.id,
      artifacts: crawl.artifacts,
      classpathAttempts: crawl.classpathAttempts,
      cacheDirectory: path.join(pipeline.workspacePath, '.gitnexus', 'jvm-artifacts'),
      lspBatch: crawl.lspBatch,
      maxDisassembledClasses: options.artifactMaxClasses,
      workerConcurrency: options.artifactConcurrency,
      fetchSources: options.fetchArtifactSources,
    },
    request.ladybug ?? (lbug as unknown as LadybugModuleLike),
    options.resume,
    bazelBuildGraph,
    pipeline.repositoryInventory,
  );
  logArtifactEnrichment(persisted.artifactEnrichment);
  return {
    batch: crawl.lspBatch,
    callNormalizationBatch,
    artifactEnrichment: persisted.artifactEnrichment,
    output: persisted.output,
    bazelBuildGraph,
    repositoryInventory: pipeline.repositoryInventory,
  };
}

function deriveLogicalCalls(request: GraphPublicationRequest): DerivedCallNormalizationBatch {
  const { pipeline, crawl } = request;
  const fingerprint = combineCheckpointFingerprint(
    'call-normalization-v1', pipeline.crawlFingerprint,
  );
  const cached = pipeline.checkpointStore.loadCached<DerivedCallNormalizationBatch>(
    'call-normalization', fingerprint,
  );
  if (cached) return cached;

  console.log('[stage:call-normalization] deriving logical invocations from LSP call observations');
  const batch = normalizeLogicalCalls(crawl.lspBatch);
  logCallNormalization(batch);
  pipeline.checkpointStore.saveCached('call-normalization', fingerprint, batch);
  return batch;
}

function fingerprintArtifactStage(
  options: LspKnowledgeGraphBuildOptions,
  crawlFingerprint: string,
  artifacts: readonly NormalizedArtifactDescriptor[],
): string {
  return combineCheckpointFingerprint(
    'jvm-artifact-enrichment-asm-stream-v2-bazel-graph',
    crawlFingerprint,
    options.artifactMaxClasses ?? null,
    options.fetchArtifactSources,
    artifacts.map((artifact) => ({
      classpathEntryPath: artifact.classpathEntryPath,
      headerJarPath: artifact.headerJarPath,
      binaryJarPath: artifact.binaryJarPath,
      contentHash: hashArtifactDescriptor(artifact),
    })),
  );
}

function hashArtifactDescriptor(artifact: NormalizedArtifactDescriptor): string {
  const selected = artifact.binaryJarPath ?? artifact.headerJarPath ?? artifact.classpathEntryPath;
  const hash = createHash('sha256');
  hash.update(path.resolve(selected));
  try {
    hash.update(fs.readFileSync(selected));
  } catch (error) {
    hash.update(`unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  return hash.digest('hex');
}

function logArtifactEnrichment(
  summary: LspKnowledgeGraphBuildResult['artifactEnrichment'],
): void {
  const run = summary.run;
  console.log(
    `[stage:jvm-artifact-enrichment] ${run.status}: ${run.artifactCount} artifacts, `
    + `${run.classCount} classes, ${run.methodCount} methods, ${run.callSiteCount} bytecode calls, `
    + `${summary.sourceAssociatedArtifactCount} source-associated artifacts`,
  );
}

function logCallNormalization(batch: DerivedCallNormalizationBatch): void {
  const run = batch.runs[0]!;
  console.log(
    `[stage:call-normalization] ${run.status}: ${run.observationCount} observations -> `
    + `${run.invocationCount} logical invocations `
    + `(${run.ambiguousObservationCount} ambiguous observations)`,
  );
}
