/**
 * LSP enrichment sub-pipeline.
 *
 * Loads `.gitnexus/graph.json` from a prior Tree-sitter (or full) run and
 * injects compiler-accurate CALLS / IMPLEMENTS. Does not re-parse source.
 */

import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineResult } from '../../types/pipeline.js';
import { knowledgeGraphFromJsonDocument, readGraphJson } from '../../graph/graph-json.js';
import { lspEnrichmentPhase } from '../pipeline-phases/index.js';
import type { PipelineOptions } from '../pipeline.js';

export async function runLspParsePipeline(
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: Omit<PipelineOptions, 'stage' | 'lsp'>,
): Promise<PipelineResult> {
  const pipelineStart = Date.now();
  const saved = readGraphJson(repoPath);
  const graph = knowledgeGraphFromJsonDocument(saved);

  onProgress({
    phase: 'enriching',
    percent: 5,
    message: `Loaded ${saved.nodes.length} nodes / ${saved.relationships.length} edges from .gitnexus/graph.json`,
  });

  await lspEnrichmentPhase.execute(
    { repoPath, graph, onProgress, options: { ...options, stage: 'lsp', lsp: true }, pipelineStart },
    new Map(),
  );

  onProgress({
    phase: 'complete',
    percent: 100,
    message: 'LSP enrichment complete.',
    stats: {
      filesProcessed: saved.stats.files,
      totalFiles: saved.stats.files,
      nodesCreated: graph.nodeCount,
    },
  });

  return {
    graph,
    repoPath,
    totalFileCount: saved.stats.files,
    resolutionOutcomes: [],
    usedWorkerPool: false,
  };
}
