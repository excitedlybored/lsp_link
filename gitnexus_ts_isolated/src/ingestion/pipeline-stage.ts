/**
 * Analyze pipeline stage — which parser(s) to run.
 *
 * Isolated from `pipeline.ts` so graph JSON and the CLI can name a stage
 * without importing the phase registry.
 */

export type PipelineStage = 'full' | 'treesitter' | 'lsp';

export const PIPELINE_STAGES: readonly PipelineStage[] = ['full', 'treesitter', 'lsp'];

export function resolvePipelineStage(stage?: string): PipelineStage {
  const resolved = (stage ?? 'full') as PipelineStage;
  if (!PIPELINE_STAGES.includes(resolved)) {
    throw new Error(`Invalid pipeline stage '${stage}'. Use: ${PIPELINE_STAGES.join(', ')}`);
  }
  return resolved;
}

export function isFullPipeline(stage?: string): boolean {
  return resolvePipelineStage(stage) === 'full';
}
