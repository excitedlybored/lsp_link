import path from 'node:path';
import {
  prepareBazelProjectModels,
  type BazelPreparationReport,
} from '../../../lsp_server/public-api.js';
import { discoverJavaBuildRoots } from '../../../lsp_server/public-api.js';
import { extractRunConfig } from '../pipeline/run-config.js';
import type { BazelTargetScope } from '../../../lsp_server/public-api.js';

interface BazelPreparationCommandOptions {
  workspace: string;
  concurrency?: number;
  timeoutMs?: number;
  targetQuery?: string;
  targetScope?: BazelTargetScope;
  scopeConfigHash?: string;
}

export async function runBazelPreparationCommand(argv: string[]): Promise<BazelPreparationReport> {
  const options = parseBazelPreparationCommandOptions(argv);
  const roots = discoverJavaBuildRoots(options.workspace).filter((root) => root.systems.includes('bazel'));
  if (roots.length === 0) {
    const report = {
      startedAt: new Date().toISOString(), durationMs: 0,
      concurrency: options.concurrency ?? 4, timedOut: false, roots: [],
    };
    console.log(JSON.stringify({
      workspace: options.workspace, durationMs: 0, roots: [],
      status: 'skipped', reason: 'No Bazel build roots discovered',
    }, null, 2));
    return report;
  }
  const report = await prepareBazelProjectModels(roots, {
    buildMode: 'managed',
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    targetQuery: options.targetQuery,
    targetScope: options.targetScope,
    scopeConfigHash: options.scopeConfigHash,
  });
  console.log(JSON.stringify({
    workspace: options.workspace,
    durationMs: report.durationMs,
    roots: report.roots.map((root) => ({
      rootId: root.rootId,
      status: root.status,
      classpathEntries: root.classpathEntries,
      crawlSources: root.crawlSources?.length,
      modelPath: root.modelPath,
      sourceInventoryPath: root.sourceInventoryPath,
      sourceInventoryHash: root.sourceInventoryHash,
      handoffPath: root.handoffPath,
      reason: root.reason,
    })),
  }, null, 2));
  const failed = report.roots.filter((root) => root.status === 'failed');
  if (failed.length > 0) {
    throw new Error(`Bazel preparation failed for ${failed.length}/${report.roots.length} roots`);
  }
  return report;
}

export function parseBazelPreparationCommandOptions(argv: string[]): BazelPreparationCommandOptions {
  const extracted = extractRunConfig(argv);
  const args = extracted.args;
  const config = extracted.config;
  if (args[0] === 'bazel-prepare' || args[0] === 'prepare-build-model') args.shift();
  const workspace = path.resolve(args.shift() ?? '.');
  let concurrency: number | undefined = config?.bazel.preparation.concurrency;
  let timeoutMs: number | undefined = config?.bazel.preparation.timeoutMs;
  let targetQuery: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--concurrency') concurrency = positiveInteger(flag, requireValue(args, flag));
    else if (flag === '--timeout-ms') timeoutMs = positiveInteger(flag, requireValue(args, flag));
    else if (flag === '--bazel-target-query') {
      if (config) throw new Error(`${flag} cannot override semantic settings loaded with --config`);
      targetQuery = requireValue(args, flag);
    }
    else throw new Error(`Unknown argument ${flag}`);
  }
  return config
    ? {
      workspace, concurrency, timeoutMs, targetQuery,
      targetScope: config.bazel.scope, scopeConfigHash: config.semanticHash,
    }
    : { workspace, concurrency, timeoutMs, targetQuery };
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer, got ${value}`);
  return parsed;
}

if (process.argv[1]?.endsWith('/bazel-prepare.ts') || process.argv[1]?.endsWith('\\bazel-prepare.ts')) {
  runBazelPreparationCommand(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
