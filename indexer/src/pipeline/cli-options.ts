import path from 'node:path';
import type { LspKnowledgeGraphBuildOptions } from './types.js';
import type { BazelBuildMode } from '../../../lsp_server/public-api.js';
import { extractRunConfig } from './run-config.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';

const BAZEL_BUILD_MODES: BazelBuildMode[] = ['managed', 'prebuilt'];
const BUILD_MODEL_MODES = ['integrated', 'prepared'] as const;

export function parseLspKnowledgeGraphBuildOptions(argv: string[]): LspKnowledgeGraphBuildOptions {
  const extracted = extractRunConfig(argv);
  const args = extracted.args;
  const config = extracted.config;
  const command = args[0];
  const crawlOverride = command === 'crawl';
  if (args[0] === 'build' || args[0] === 'build-index' || args[0] === 'index' || args[0] === 'crawl') args.shift();
  const workspace = path.resolve(args.shift() ?? '.');
  let output = path.join(workspace, '.gitnexus', 'lsp-lbug');
  let concurrency = config?.crawl.concurrency ?? 4;
  let jdtProcesses = config?.crawl.jdtProcesses ?? 1;
  let artifactMaxClasses: number | undefined = config?.artifacts.maxClasses;
  let artifactConcurrency = config?.artifacts.concurrency ?? 4;
  let fetchArtifactSources = config?.artifacts.fetchSources ?? true;
  let checkpointDirectory: string | undefined = config?.checkpoints.directory;
  let resume = config?.crawl.resume ?? true;
  let crawlProfile: CrawlProfile = config?.crawl.profile ?? 'exhaustive';
  let javaSemantics = config?.crawl.javaSemantics ?? 'batch';
  let bazelBuildMode: BazelBuildMode = config?.bazel.buildModelMode === 'prepared' ? 'prebuilt' : 'managed';
  let bazelTargetQuery: string | undefined;
  const artifactManifestPaths: string[] = [...(config?.artifacts.classpathManifests ?? [])];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') output = path.resolve(requireFlagValue(args, flag));
    else if (flag === '--concurrency') concurrency = Number(requireFlagValue(args, flag));
    else if (flag === '--jdt-processes') jdtProcesses = Number(requireFlagValue(args, flag));
    else if (flag === '--profile') {
      semanticConflict(config, flag, crawlOverride);
      const value = requireFlagValue(args, flag);
      if (value !== 'core' && value !== 'exhaustive') throw new Error(`${flag} must be core or exhaustive`);
      crawlProfile = value;
    }
    else if (flag === '--java-semantics') {
      semanticConflict(config, flag, crawlOverride);
      const value = requireFlagValue(args, flag);
      if (value !== 'batch' && value !== 'lsp') throw new Error(`${flag} must be batch or lsp`);
      javaSemantics = value;
    }
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
  requirePositiveInteger('--jdt-processes', jdtProcesses);
  if (artifactMaxClasses !== undefined) requirePositiveInteger('--artifact-max-classes', artifactMaxClasses);
  requirePositiveInteger('--artifact-concurrency', artifactConcurrency);
  if (artifactConcurrency > 16) {
    throw new Error(`--artifact-concurrency must be at most 16, got ${artifactConcurrency}`);
  }
  return {
    workspace,
    output,
    concurrency,
    jdtProcesses,
    artifactMaxClasses,
    artifactConcurrency,
    fetchArtifactSources,
    artifactManifestPaths,
    checkpointDirectory: checkpointDirectory ?? `${output}.checkpoints`,
    resume,
    crawlProfile,
    javaSemantics,
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

function semanticConflict(config: unknown, flag: string, allowed = false): void {
  if (config && !allowed) throw new Error(`${flag} cannot override semantic settings loaded with --config`);
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
