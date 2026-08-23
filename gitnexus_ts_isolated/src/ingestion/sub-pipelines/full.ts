/**
 * Full analyze pipeline: Tree-sitter parse, then LSP enrichment, then graph analysis.
 */

import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineResult } from '../../types/pipeline.js';
import { runPipelineFromRepo, type PipelineOptions } from '../pipeline.js';

export async function runAnalyzePipeline(
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: Omit<PipelineOptions, 'stage'>,
): Promise<PipelineResult> {
  return runPipelineFromRepo(repoPath, onProgress, { ...options, stage: 'full' });
}
