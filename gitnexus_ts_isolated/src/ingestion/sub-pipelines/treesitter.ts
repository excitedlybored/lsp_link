/**
 * Tree-sitter parse sub-pipeline.
 *
 * Scan → structure → parse. No LSP, no post-parse analysis.
 * Persist `.gitnexus/graph.json` from the CLI so `runLspParsePipeline` can resume.
 */

import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineResult } from '../../types/pipeline.js';
import { runPipelineFromRepo, type PipelineOptions } from '../pipeline.js';

export async function runTreesitterParsePipeline(
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: Omit<PipelineOptions, 'stage' | 'lsp'>,
): Promise<PipelineResult> {
  return runPipelineFromRepo(repoPath, onProgress, { ...options, stage: 'treesitter', lsp: false });
}
