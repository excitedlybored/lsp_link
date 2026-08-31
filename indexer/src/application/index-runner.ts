/** Functional application composition for crawl and graph-publication stages. */

import type {
  LspKnowledgeGraphBuildOptions,
  LspKnowledgeGraphBuildResult,
  LspRepositoryCrawlResult,
} from '../pipeline/types.js';
import { LspAdapterRegistry } from '../../../lsp_server/public-api.js';
import { publishKnowledgeGraph } from './graph-publication-stage.js';
import { preparePipeline } from './pipeline-preparation-stage.js';
import { crawlCheckpointPath, executeSemanticCrawl } from './semantic-crawl-stage.js';

type PipelineMode = 'index' | 'crawl';

export async function buildLspKnowledgeGraph(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspKnowledgeGraphBuildResult> {
  return runPipeline('index', options, adapterRegistry);
}

export async function crawlLspRepository(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspRepositoryCrawlResult> {
  return runPipeline('crawl', options, adapterRegistry);
}

function runPipeline(
  mode: 'index',
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
): Promise<LspKnowledgeGraphBuildResult>;
function runPipeline(
  mode: 'crawl',
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
): Promise<LspRepositoryCrawlResult>;
async function runPipeline(
  mode: PipelineMode,
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry: LspAdapterRegistry,
): Promise<LspKnowledgeGraphBuildResult | LspRepositoryCrawlResult> {
  const metrics = startPipelineMetrics();
  try {
    const pipeline = await preparePipeline(options, adapterRegistry);
    const crawl = await executeSemanticCrawl({
      options,
      adapterRegistry,
      pipeline,
      crawlOnly: mode === 'crawl',
    });
    if (mode === 'crawl') {
      return {
        batch: crawl.lspBatch,
        artifacts: crawl.artifacts,
        classpathAttempts: crawl.classpathAttempts,
        checkpoint: crawlCheckpointPath(pipeline),
        crawlFingerprint: pipeline.crawlFingerprint,
        durationMs: Date.now() - metrics.startedAt,
        peakNodeRssMiB: Math.round(metrics.peakRssBytes() / 1024 / 1024 * 100) / 100,
        repositoryInventory: pipeline.repositoryInventory,
      };
    }
    return publishKnowledgeGraph({ options, pipeline, crawl });
  } finally {
    metrics.stop();
    await adapterRegistry.shutdownAll();
  }
}

function startPipelineMetrics(): {
  readonly startedAt: number;
  readonly peakRssBytes: () => number;
  readonly stop: () => void;
} {
  const startedAt = Date.now();
  let peakRssBytes = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }, 250);
  sampler.unref();
  return {
    startedAt,
    peakRssBytes: () => peakRssBytes,
    stop: () => clearInterval(sampler),
  };
}
