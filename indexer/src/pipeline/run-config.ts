import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BazelBuildMode, BazelTargetScope } from '../../../lsp_server/adapters/java/bazel-project-model.js';
import type { CrawlPlannerMode } from '../ingest/crawl-planner.js';
import { CRAWL_PROFILES, type CrawlProfile } from '../ingest/crawl-profile.js';

export interface LspLinkRunConfig {
  schemaVersion: 1;
  name: string;
  path: string;
  semanticHash: string;
  bazel: {
    buildMode: BazelBuildMode;
    scope: BazelTargetScope;
    preparation: { concurrency: number; timeoutMs: number };
  };
  crawl: { profile: CrawlProfile; planner: CrawlPlannerMode; concurrency: number; resume: boolean };
  artifacts: {
    concurrency: number; maxClasses?: number; fetchSources: boolean; classpathManifests: string[];
  };
  quality: { failOnFailedBuildRoot: boolean };
  checkpoints: { directory?: string };
}

export function extractRunConfig(argv: string[]): { args: string[]; config?: LspLinkRunConfig } {
  const args = [...argv];
  const index = args.indexOf('--config');
  if (index < 0) return { args };
  const configPath = args[index + 1];
  if (!configPath || configPath.startsWith('--')) throw new Error('--config requires a value');
  if (args.indexOf('--config', index + 1) >= 0) throw new Error('--config may be supplied only once');
  args.splice(index, 2);
  return { args, config: loadRunConfig(configPath) };
}

export function loadRunConfig(configPath: string): LspLinkRunConfig {
  const resolved = path.resolve(configPath);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON run config ${resolved}: ${message(error)}`); }
  const root = object(raw, 'config');
  keys(root, ['schemaVersion', 'name', 'bazel', 'crawl', 'artifacts', 'quality', 'checkpoints'], 'config');
  if (root.schemaVersion !== 1) throw new Error(`config.schemaVersion must be 1, got ${String(root.schemaVersion)}`);
  const directory = path.dirname(resolved);
  const bazel = object(root.bazel, 'config.bazel');
  keys(bazel, ['buildMode', 'scope', 'preparation'], 'config.bazel');
  const scope = parseScope(bazel.scope);
  const preparation = object(bazel.preparation === undefined ? {} : bazel.preparation, 'config.bazel.preparation');
  keys(preparation, ['concurrency', 'timeoutMs'], 'config.bazel.preparation');
  const crawl = object(root.crawl === undefined ? {} : root.crawl, 'config.crawl');
  keys(crawl, ['profile', 'planner', 'concurrency', 'resume'], 'config.crawl');
  const artifacts = object(root.artifacts === undefined ? {} : root.artifacts, 'config.artifacts');
  keys(artifacts, ['concurrency', 'maxClasses', 'fetchSources', 'classpathManifests'], 'config.artifacts');
  const quality = object(root.quality === undefined ? {} : root.quality, 'config.quality');
  keys(quality, ['failOnFailedBuildRoot'], 'config.quality');
  const checkpoints = object(root.checkpoints === undefined ? {} : root.checkpoints, 'config.checkpoints');
  keys(checkpoints, ['directory'], 'config.checkpoints');
  const buildMode = enumeration(bazel.buildMode === undefined ? 'managed' : bazel.buildMode, ['managed', 'prebuilt'], 'config.bazel.buildMode');
  const planner = enumeration(crawl.planner === undefined ? 'legacy' : crawl.planner, ['legacy', 'facts-first'], 'config.crawl.planner');
  const profile = enumeration(crawl.profile === undefined ? 'exhaustive' : crawl.profile, CRAWL_PROFILES, 'config.crawl.profile');
  const semantic = {
    schemaVersion: 1, name: string(root.name === undefined ? 'default' : root.name, 'config.name'),
    bazel: { buildMode, scope }, profile, planner,
    artifacts: {
      maxClasses: optionalPositive(artifacts.maxClasses, 'config.artifacts.maxClasses'),
      fetchSources: boolean(artifacts.fetchSources === undefined ? true : artifacts.fetchSources, 'config.artifacts.fetchSources'),
      classpathManifests: strings(artifacts.classpathManifests === undefined ? [] : artifacts.classpathManifests, 'config.artifacts.classpathManifests')
        .map((value) => path.resolve(directory, value)),
    },
  };
  return {
    schemaVersion: 1, name: semantic.name, path: resolved,
    semanticHash: createHash('sha256').update(JSON.stringify(semantic)).digest('hex'),
    bazel: {
      buildMode,
      scope,
      preparation: {
        concurrency: positive(preparation.concurrency === undefined ? 4 : preparation.concurrency, 'config.bazel.preparation.concurrency'),
        timeoutMs: positive(preparation.timeoutMs === undefined ? 600_000 : preparation.timeoutMs, 'config.bazel.preparation.timeoutMs'),
      },
    },
    crawl: {
      profile,
      planner,
      concurrency: positive(crawl.concurrency === undefined ? 4 : crawl.concurrency, 'config.crawl.concurrency'),
      resume: boolean(crawl.resume === undefined ? true : crawl.resume, 'config.crawl.resume'),
    },
    artifacts: {
      concurrency: bounded(artifacts.concurrency === undefined ? 4 : artifacts.concurrency, 1, 16, 'config.artifacts.concurrency'),
      maxClasses: semantic.artifacts.maxClasses,
      fetchSources: semantic.artifacts.fetchSources,
      classpathManifests: semantic.artifacts.classpathManifests,
    },
    quality: { failOnFailedBuildRoot: boolean(quality.failOnFailedBuildRoot === undefined ? true : quality.failOnFailedBuildRoot, 'config.quality.failOnFailedBuildRoot') },
    checkpoints: {
      directory: checkpoints.directory === undefined || checkpoints.directory === null
        ? undefined : path.resolve(directory, string(checkpoints.directory, 'config.checkpoints.directory')),
    },
  };
}

function parseScope(value: unknown): BazelTargetScope {
  const scope = object(value, 'config.bazel.scope');
  keys(scope, ['includeTargetPatterns', 'includeRuleKinds', 'explicitTargets', 'excludeTargetNamePatterns', 'excludeLabels', 'excludeTags'], 'config.bazel.scope');
  const result: BazelTargetScope = {
    includeTargetPatterns: strings(scope.includeTargetPatterns, 'config.bazel.scope.includeTargetPatterns'),
    includeRuleKinds: strings(scope.includeRuleKinds, 'config.bazel.scope.includeRuleKinds'),
    explicitTargets: strings(scope.explicitTargets === undefined ? [] : scope.explicitTargets, 'config.bazel.scope.explicitTargets'),
    excludeTargetNamePatterns: strings(scope.excludeTargetNamePatterns === undefined ? [] : scope.excludeTargetNamePatterns, 'config.bazel.scope.excludeTargetNamePatterns'),
    excludeLabels: strings(scope.excludeLabels === undefined ? [] : scope.excludeLabels, 'config.bazel.scope.excludeLabels'),
    excludeTags: strings(scope.excludeTags === undefined ? [] : scope.excludeTags, 'config.bazel.scope.excludeTags'),
  };
  if (result.includeTargetPatterns.length === 0 && result.explicitTargets.length === 0) {
    throw new Error('config.bazel.scope requires includeTargetPatterns or explicitTargets');
  }
  for (const pattern of result.excludeTargetNamePatterns) {
    try { new RegExp(pattern); } catch { throw new Error(`Invalid target-name regex: ${pattern}`); }
  }
  const excluded = new Set(result.excludeLabels);
  const conflict = result.explicitTargets.find((label) => excluded.has(label));
  if (conflict) throw new Error(`Explicit target is also excluded: ${conflict}`);
  return result;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${name} contains unknown keys: ${unknown.join(', ')}`);
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value)].sort();
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}
function positive(value: unknown, name: string): number { return bounded(value, 1, Number.MAX_SAFE_INTEGER, name); }
function optionalPositive(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positive(value, name);
}
function bounded(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return value as T;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
