import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  dedupeObservationBatch,
  emptyObservationBatch,
  mergeObservationBatches,
  type LspObservationBatch,
} from '../ingest/batch.js';
import type { LspKnowledgeGraphBuildOptions } from '../pipeline/types.js';
import { startMemoryTelemetry } from '../telemetry/memory.js';
import { LspAdapterRegistry } from '../../../lsp_server/public-api.js';
import { crawlJavaWorkspace, type JavaCrawlCheckpoint } from './java-crawl-stage.js';
import { crawlRegisteredRepositoryLanguages } from './polyglot-crawl-stage.js';
import type { PreparedPipeline } from './pipeline-preparation-stage.js';

export interface SemanticCrawlRequest {
  readonly options: LspKnowledgeGraphBuildOptions;
  readonly adapterRegistry: LspAdapterRegistry;
  readonly pipeline: PreparedPipeline;
  readonly crawlOnly: boolean;
}

/** Resolves the semantic checkpoint or performs one Java/polyglot crawl. */
export async function executeSemanticCrawl(
  request: SemanticCrawlRequest,
): Promise<JavaCrawlCheckpoint> {
  const { options, adapterRegistry, pipeline, crawlOnly } = request;
  const cacheTelemetry = startMemoryTelemetry('crawl-cache-loading', {
    cache: 'lsp-crawl', cacheId: pipeline.crawlFingerprint,
  });
  const cached = pipeline.checkpointStore.loadCached<JavaCrawlCheckpoint>(
    'lsp-crawl', pipeline.crawlFingerprint,
  );
  cacheTelemetry.end();

  const crawl = cached ?? await crawlSemanticSources(request);
  ensureRequiredSemanticCoverage(crawl.lspBatch, options, crawlOnly);

  if (!cached && !(crawlOnly && hasIncompleteBatchJavaServer(crawl.lspBatch, options.javaSemantics))) {
    pipeline.checkpointStore.saveCached('lsp-crawl', pipeline.crawlFingerprint, crawl);
  }
  if (crawlOnly) {
    pipeline.checkpointStore.save('lsp-crawl', pipeline.crawlFingerprint, crawl);
  }
  return crawl;
}

export function crawlCheckpointPath(pipeline: PreparedPipeline): string {
  return path.join(pipeline.checkpointStore.directory, 'lsp-crawl.checkpoint');
}

async function crawlSemanticSources(
  request: SemanticCrawlRequest,
): Promise<JavaCrawlCheckpoint> {
  const { options, adapterRegistry, pipeline } = request;
  const javaCrawl = pipeline.activeRoots.length > 0
    ? await crawlJavaWorkspace({
      options,
      adapterRegistry,
      workspacePath: pipeline.workspacePath,
      activeRoots: [...pipeline.activeRoots],
      filesByRoot: new Map(pipeline.filesByRoot),
      preparations: [...pipeline.preparation],
      checkpointStore: pipeline.checkpointStore,
      crawlFingerprint: pipeline.crawlFingerprint,
    })
    : emptySemanticCrawl(pipeline.workspacePath, pipeline.crawlFingerprint);
  const run = javaCrawl.lspBatch.analysisRuns[0]!;
  const polyglotBatch = await crawlRegisteredRepositoryLanguages({
    workspacePath: pipeline.workspacePath,
    run,
    repositoryInventory: pipeline.repositoryInventory,
    adapterRegistry,
    profile: options.crawlProfile,
    semanticSourcePaths: [...pipeline.registeredSemanticFiles],
  });
  return {
    ...javaCrawl,
    lspBatch: dedupeObservationBatch(mergeObservationBatches(javaCrawl.lspBatch, polyglotBatch)),
  };
}

function ensureRequiredSemanticCoverage(
  batch: LspObservationBatch,
  options: LspKnowledgeGraphBuildOptions,
  crawlOnly: boolean,
): void {
  const failedServers = batch.servers.filter((server) => server.status === 'failed');
  if (options.failOnFailedBuildRoot && failedServers.length > 0) {
    const failedRoots = [...new Set(failedServers.map((server) => server.buildRootId ?? server.id))].sort();
    throw new Error(`Semantic crawl failed for build roots: ${failedRoots.join(', ')}`);
  }
  if (crawlOnly && hasIncompleteBatchJavaServer(batch, options.javaSemantics)) {
    throw new Error('Crawl-only validation requires every JDT batch server to complete');
  }
}

function hasIncompleteBatchJavaServer(
  batch: LspObservationBatch,
  javaSemantics: string,
): boolean {
  return javaSemantics === 'batch' && batch.servers.some((server) =>
    server.languageId === 'java'
    && server.name.startsWith('JDT Language Server')
    && server.status !== 'complete');
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
