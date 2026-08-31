import path from 'node:path';
import type { LspKnowledgeGraphBuildOptions } from './types.js';
import type { BazelBuildMode } from '../../../lsp_server/adapters/java/bazel-project-model.js';
import { extractRunConfig } from './run-config.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';

const BAZEL_BUILD_MODES: BazelBuildMode[] = ['managed', 'prebuilt'];
const BUILD_MODEL_MODES = ['integrated', 'prepared'] as const;

export function parseLspKnowledgeGraphBuildOptions(argv: string[]): LspKnowledgeGraphBuildOptions {
  const extracted = extractRunConfig(argv);
  const args = extracted.args;
  const config = extracted.config;
  if (args[0] === 'build' || args[0] === 'build-index' || args[0] === 'index') args.shift();
  const workspace = path.resolve(args.shift() ?? '.');
  let output = path.join(workspace, '.gitnexus', 'lsp-lbug');
  let concurrency = config?.crawl.concurrency ?? 4;
  let artifactMaxClasses: number | undefined = config?.artifacts.maxClasses;
  let artifactConcurrency = config?.artifacts.concurrency ?? 4;
  let fetchArtifactSources = config?.artifacts.fetchSources ?? true;
  let checkpointDirectory: string | undefined = config?.checkpoints.directory;
  let resume = config?.crawl.resume ?? true;
  const crawlProfile: CrawlProfile = config?.crawl.profile ?? 'exhaustive';
  let bazelBuildMode: BazelBuildMode = config?.bazel.buildModelMode === 'prepared' ? 'prebuilt' : 'managed';
  let bazelTargetQuery: string | undefined;
  const artifactManifestPaths: string[] = [...(config?.artifacts.classpathManifests ?? [])];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') output = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--concurrency') concurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--artifact-max-classes') { semanticConflict(config, flag); artifactMaxClasses = Number(requireFlagValue(args, flag)); }
    else if (flag === '--artifact-concurrency') artifactConcurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--checkpoint-directory') checkpointDirectory = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--no-resume') resume = false;
    else if (flag === '--bazel-build-mode') {
      semanticConflict(config, flag);
      const value = requireFlagValue(args, flag);
      if (!BAZEL_BUILD_MODES.includes(value as BazelBuildMode)) {
        throw new Error(`${flag} must be one of ${BAZEL_BUILD_MODES.join(', ')}, got ${value}`);
      }
      bazelBuildMode = value as BazelBuildMode;
    }
    else if (flag === '--build-model-mode') {
      semanticConflict(config, flag);
      const value = requireFlagValue(args, flag);
      if (!BUILD_MODEL_MODES.includes(value as typeof BUILD_MODEL_MODES[number])) {
        throw new Error(`${flag} must be one of ${BUILD_MODEL_MODES.join(', ')}, got ${value}`);
      }
      bazelBuildMode = value === 'prepared' ? 'prebuilt' : 'managed';
    }
    else if (flag === '--bazel-target-query') { semanticConflict(config, flag); bazelTargetQuery = requireFlagValue(args, flag); }
    else if (flag === '--no-artifact-source-fetch') { semanticConflict(config, flag); fetchArtifactSources = false; }
    else if (flag === '--artifact-classpath-manifest') {
      semanticConflict(config, flag);
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
    crawlProfile,
    bazelBuildMode,
    bazelTargetQuery,
    bazelTargetScope: config?.bazel.scope,
    runConfigPath: config?.path,
    runConfigHash: config?.semanticHash,
    bazelPreparationConcurrency: config?.bazel.preparation.concurrency,
    bazelPreparationTimeoutMs: config?.bazel.preparation.timeoutMs,
    failOnFailedBuildRoot: config?.quality.failOnFailedBuildRoot ?? false,
  };
}

function semanticConflict(config: unknown, flag: string): void {
  if (config) throw new Error(`${flag} cannot override semantic settings loaded with --config`);
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
