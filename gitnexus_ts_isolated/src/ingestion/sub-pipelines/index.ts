/**
 * Dispatch an analyze request to the Tree-sitter, LSP, or full sub-pipeline.
 */

import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineResult } from '../../types/pipeline.js';
import { resolvePipelineStage } from '../pipeline-stage.js';
import type { PipelineOptions } from '../pipeline.js';
import { runTreesitterParsePipeline } from './treesitter.js';
import { runLspParsePipeline } from './lsp.js';
import { runAnalyzePipeline } from './full.js';

export { runTreesitterParsePipeline } from './treesitter.js';
export { runLspParsePipeline } from './lsp.js';
export { runAnalyzePipeline } from './full.js';

/**
 * Run the named sub-pipeline. This is the CLI entry point — do not call
 * `runPipelineFromRepo` with `stage: 'lsp'`; that engine only executes
 * registered phases and cannot load a saved graph.
 */
export async function runPipelineStage(
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const stage = resolvePipelineStage(options?.stage);

  switch (stage) {
    case 'treesitter':
      return runTreesitterParsePipeline(repoPath, onProgress, options);
    case 'lsp':
      if (options?.lsp === false) {
        throw new Error('The lsp pipeline requires Language Server enrichment. Do not pass --no-lsp.');
      }
      return runLspParsePipeline(repoPath, onProgress, options);
    case 'full':
      return runAnalyzePipeline(repoPath, onProgress, options);
  }
}
