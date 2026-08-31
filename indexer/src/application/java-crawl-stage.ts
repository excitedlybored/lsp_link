import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArtifactClasspathResolver,
  retainArtifactClasspathEntries,
  type ArtifactClasspathProviderAttempt,
  type NormalizedArtifactDescriptor,
} from '../artifact/classpath/index.js';
import { dedupeObservationBatch, mergeObservationBatches, type LspObservationBatch } from '../ingest/batch.js';
import type { LspAnalysisRun } from '../model.js';
import { PipelineCheckpointStore } from '../pipeline/checkpoints.js';
import { mapConcurrently } from '../pipeline/concurrency.js';
import { crawlJavaBuildRoot } from '../pipeline/java-build-root-crawler.js';
import type {
  JavaBuildRootCrawlResult,
  JavaBuildRootPreparation,
  LspKnowledgeGraphBuildOptions,
} from '../pipeline/types.js';
import type { JavaBuildRoot } from '../../../lsp_server/adapters/java/jdtls-runtime.js';
import {
  cleanupJdtlsShardWorkspace,
  planJdtlsBuildRootShardsWithinBudget,
  prepareJdtlsShardWorkspace,
} from '../../../lsp_server/adapters/java/jdtls-sharding.js';
import { LspAdapterRegistry } from '../../../lsp_server/registry/lsp-adapter-registry.js';

export interface JavaCrawlCheckpoint {
  lspBatch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  classpathAttempts: ArtifactClasspathProviderAttempt[];
}

export interface CrawlJavaWorkspaceRequest {
  options: LspKnowledgeGraphBuildOptions;
  adapterRegistry: LspAdapterRegistry;
  workspacePath: string;
  activeRoots: JavaBuildRoot[];
  filesByRoot: Map<string, string[]>;
  preparations: JavaBuildRootPreparation[];
  checkpointStore: PipelineCheckpointStore;
  crawlFingerprint: string;
}

/** Runs the checkpointed JDT crawl stage independently of CLI orchestration. */
export async function crawlJavaWorkspace(
  request: CrawlJavaWorkspaceRequest,
): Promise<JavaCrawlCheckpoint> {
  const {
    options, adapterRegistry, workspacePath, activeRoots, filesByRoot,
    preparations, checkpointStore, crawlFingerprint,
  } = request;
  console.log(
    `[stage:lsp-crawl] preparing ${activeRoots.length} Java build roots `
    + `(concurrency=${options.concurrency})`,
  );
  const run = createAnalysisRun(workspacePath, `run:${crawlFingerprint}`);
  run.configurationHash = options.runConfigHash;
  const artifactClasspathResolver = new ArtifactClasspathResolver();
  const cachedByRoot = new Map<string, JavaBuildRootCrawlResult>();
  for (const root of activeRoots) {
    const cached = checkpointStore.loadCached<JavaBuildRootCrawlResult>(
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

  const preparationsByRoot = new Map(preparations.map((result) => [result.rootId, result]));
  const workspaceSessionId = `${process.pid}-${randomUUID()}`;
  const sourceCounts = new Map(activeRoots.map((root) => [root.id, filesByRoot.get(root.id)?.length ?? 0]));
  const heapBudgetGb = jdtlsHeapBudgetGb();
  const shardPlans = planJdtlsBuildRootShardsWithinBudget(
    activeRoots, options.concurrency, sourceCounts, heapBudgetGb,
  )
    .filter((plan) => plan.roots.some((root) => !cachedByRoot.has(root.id)));
  console.log(
    `[stage:lsp-crawl] starting ${shardPlans.length} persistent JDT LS shards: `
    + shardPlans.map((shard) => `${shard.id}=${shard.roots.length} roots/${shard.sourceFileCount} files`).join(', '),
  );
  const shardResults = await mapConcurrently(shardPlans, Math.max(1, shardPlans.length), async (shardPlan) => {
    const pendingRoots = shardPlan.roots.filter((root) => !cachedByRoot.has(root.id));
    const shard = prepareJdtlsShardWorkspace(
      workspacePath,
      { ...shardPlan, roots: pendingRoots },
      workspaceSessionId,
    );
    const adapter = await adapterRegistry.getOrStartJavaShard(shard);
    const results: JavaBuildRootCrawlResult[] = [];
    try {
      for (const root of pendingRoots) {
        const files = filesByRoot.get(root.id) ?? [];
        console.log(`[${root.id}] crawling ${files.length} files on ${shard.id}`);
        const result = await crawlJavaBuildRoot({
          adapterRegistry,
          artifactClasspathResolver,
          repositoryPath: workspacePath,
          run,
          root,
          files,
          preparation: preparationsByRoot.get(root.id),
          artifactManifestPaths: options.artifactManifestPaths,
          sharedAdapter: adapter ?? undefined,
          processShardId: shard.id,
          requireSharedAdapter: true,
          crawlProfile: options.crawlProfile,
        });
        result.artifacts = retainArtifactClasspathEntries(
          result.artifacts,
          path.join(workspacePath, '.gitnexus', 'jvm-artifacts', 'classpath'),
        );
        checkpointStore.saveCached(checkpointStore.rootStage(root.id), crawlFingerprint, result);
        completedRootCount += 1;
        console.log(`[${root.id}] complete (${completedRootCount}/${activeRoots.length})`);
        results.push(result);
      }
      return results;
    } finally {
      if (adapter) await adapterRegistry.shutdownAdapter(adapter);
      cleanupJdtlsShardWorkspace(shard);
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

function jdtlsHeapBudgetGb(): number {
  const value = Number(process.env.GITNEXUS_JDT_MAX_TOTAL_HEAP_GB ?? 8);
  if (!Number.isFinite(value) || value < 2) {
    throw new Error('GITNEXUS_JDT_MAX_TOTAL_HEAP_GB must be at least 2');
  }
  return value;
}

function assembleCrawlCheckpoint(
  run: LspAnalysisRun,
  rootResults: JavaBuildRootCrawlResult[],
): JavaCrawlCheckpoint {
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
