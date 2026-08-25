import path from 'node:path';
import type { LspKnowledgeGraphBuildOptions } from './types.js';

export function parseLspKnowledgeGraphBuildOptions(argv: string[]): LspKnowledgeGraphBuildOptions {
  const args = [...argv];
  if (args[0] === 'build') args.shift();
  const workspace = path.resolve(args.shift() ?? '.');
  let output = path.join(workspace, '.gitnexus', 'lsp-lbug');
  let concurrency = 4;
  let artifactMaxClasses: number | undefined;
  let artifactConcurrency = 4;
  let fetchArtifactSources = true;
  let checkpointDirectory: string | undefined;
  let resume = true;
  const artifactManifestPaths: string[] = [];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') output = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--concurrency') concurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--artifact-max-classes') artifactMaxClasses = Number(requireFlagValue(args, flag));
    else if (flag === '--artifact-concurrency') artifactConcurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--checkpoint-directory') checkpointDirectory = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--no-resume') resume = false;
    else if (flag === '--no-artifact-source-fetch') fetchArtifactSources = false;
    else if (flag === '--artifact-classpath-manifest') {
      artifactManifestPaths.push(path.resolve(requireFlagValue(args, flag)));
    } else {
      throw new Error(`Unknown argument ${flag}`);
    }
  }
  requirePositiveInteger('--concurrency', concurrency);
  if (artifactMaxClasses !== undefined) requirePositiveInteger('--artifact-max-classes', artifactMaxClasses);
  requirePositiveInteger('--artifact-concurrency', artifactConcurrency);
  return {
    workspace,
    output,
    concurrency,
    artifactMaxClasses,
    artifactConcurrency,
    fetchArtifactSources,
    artifactManifestPaths,
    checkpointDirectory: checkpointDirectory ?? `${output}.checkpoints`,
    resume,
  };
}

function requireFlagValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function requirePositiveInteger(flag: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got ${value}`);
  }
}
