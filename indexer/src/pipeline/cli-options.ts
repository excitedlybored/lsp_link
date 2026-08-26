import path from 'node:path';
import type { LspKnowledgeGraphBuildOptions } from './types.js';
import { CRAWL_PLANNER_MODES, type CrawlPlannerMode } from '../ingest/crawl-planner.js';
import type { BazelBuildMode } from '../../../lsp_server/adapters/java/bazel-project-model.js';

const BAZEL_BUILD_MODES: BazelBuildMode[] = ['managed', 'prebuilt'];

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
  let crawlPlanner: CrawlPlannerMode = 'legacy';
  let bazelBuildMode: BazelBuildMode = 'managed';
  const artifactManifestPaths: string[] = [];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') output = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--concurrency') concurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--artifact-max-classes') artifactMaxClasses = Number(requireFlagValue(args, flag));
    else if (flag === '--artifact-concurrency') artifactConcurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--checkpoint-directory') checkpointDirectory = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--no-resume') resume = false;
    else if (flag === '--crawl-planner') {
      const value = requireFlagValue(args, flag);
      if (!CRAWL_PLANNER_MODES.includes(value as CrawlPlannerMode)) {
        throw new Error(`${flag} must be one of ${CRAWL_PLANNER_MODES.join(', ')}, got ${value}`);
      }
      crawlPlanner = value as CrawlPlannerMode;
    }
    else if (flag === '--bazel-build-mode') {
      const value = requireFlagValue(args, flag);
      if (!BAZEL_BUILD_MODES.includes(value as BazelBuildMode)) {
        throw new Error(`${flag} must be one of ${BAZEL_BUILD_MODES.join(', ')}, got ${value}`);
      }
      bazelBuildMode = value as BazelBuildMode;
    }
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
  if (artifactConcurrency > 16) {
    throw new Error(`--artifact-concurrency must be at most 16, got ${artifactConcurrency}`);
  }
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
    crawlPlanner,
    bazelBuildMode,
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
