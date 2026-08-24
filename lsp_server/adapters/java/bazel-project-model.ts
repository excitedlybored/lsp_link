import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { globSync } from 'glob';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_RELATIVE_PATH = '.gitnexus/jdtls/bazel-project.json';

interface GeneratedBazelModel {
  javaMajor?: number;
  classpath: string[];
  sourcePaths: string[];
  generatedBy: 'gitnexus-bazel-cquery';
  generatedAt: string;
  configurationHash: string;
  bazelBinary: string;
  targetQuery: string;
}

export interface BazelModelGenerationResult {
  status: 'generated' | 'cached' | 'disabled' | 'failed';
  modelPath?: string;
  classpathEntries?: number;
  configurationHash?: string;
  reason?: string;
}

export interface BazelPreparationRoot {
  id: string;
  workspacePath: string;
  systems: string[];
}

export interface BazelRootPreparationResult extends BazelModelGenerationResult {
  rootId: string;
  workspacePath: string;
  durationMs: number;
}

export interface BazelPreparationReport {
  startedAt: string;
  durationMs: number;
  concurrency: number;
  timedOut: boolean;
  roots: BazelRootPreparationResult[];
}

export interface BazelModelGenerationOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface BazelPreparationOptions {
  concurrency?: number;
  timeoutMs?: number;
  preferredRootIds?: string[];
  generate?: (workspacePath: string, options: BazelModelGenerationOptions) => Promise<BazelModelGenerationResult>;
}

/** Generate the exact external model JDT.LS needs from Bazel's configured JavaInfo graph. */
export async function ensureBazelProjectModel(
  workspacePath: string,
  options: BazelModelGenerationOptions = {}
): Promise<BazelModelGenerationResult> {
  if (envBoolean('GITNEXUS_JDT_BAZEL_AUTO_MODEL') === false) return { status: 'disabled' };
  if (!hasBazelWorkspaceMarker(workspacePath)) return { status: 'disabled' };

  const configuredPath = process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL;
  const modelPath = path.resolve(workspacePath, configuredPath || MODEL_RELATIVE_PATH);
  if (configuredPath && fs.existsSync(modelPath)) return cachedResult(modelPath);

  const configurationHash = bazelConfigurationHash(workspacePath);
  const sourcePaths = discoverSourcePaths(workspacePath);
  const existing = readGeneratedModel(modelPath);
  if (
    existing?.configurationHash === configurationHash
    && arraysEqual(existing.sourcePaths, sourcePaths)
    && existing.classpath.every(fs.existsSync)
  ) {
    return cachedResult(modelPath, existing.classpath.length, existing.configurationHash);
  }
  if (existing) quarantineStaleModel(modelPath);

  const bazelBinary = findBazelBinary();
  if (!bazelBinary) return { status: 'failed', reason: 'Neither bazelisk nor bazel was found on PATH.' };

  const timeout = positiveInteger(process.env.GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  // Provider-based filtering is deliberate: custom/Starlark Java rules need not
  // have a native `java_*` rule kind, but JavaInfo is the stable contract.
  const targetQuery = process.env.GITNEXUS_JDT_BAZEL_TARGETS || '//...';
  try {
    const executionRoot = (await runBazel(bazelBinary, ['info', 'execution_root'], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal)).trim();
    const expression = '"\\t".join([str(target.label)] + [f.path for f in providers(target)["JavaInfo"].transitive_compile_time_jars.to_list()]) if "JavaInfo" in providers(target) else ""';
    const output = await runBazel(bazelBinary, [
      'cquery', targetQuery, '--output=starlark', `--starlark:expr=${expression}`,
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    const configured = parseConfiguredTargets(output, executionRoot);
    if (configured.labels.length === 0 || configured.classpath.length === 0) {
      return { status: 'failed', reason: `Bazel cquery returned no JavaInfo compile-time jars for ${targetQuery}.` };
    }
    if (configured.classpath.some((jar) => !fs.existsSync(jar))) {
      const targetFile = path.join(workspacePath, '.gitnexus/jdtls/bazel-targets.txt');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, `${configured.labels.join('\n')}\n`);
      await runBazel(bazelBinary, ['build', `--target_pattern_file=${targetFile}`], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    }
    const missing = configured.classpath.filter((jar) => !fs.existsSync(jar));
    if (missing.length > 0) {
      return { status: 'failed', reason: `Bazel did not materialize ${missing.length} configured Java compile-time jars.` };
    }

    const model: GeneratedBazelModel = {
      classpath: configured.classpath,
      sourcePaths,
      generatedBy: 'gitnexus-bazel-cquery',
      generatedAt: new Date().toISOString(),
      configurationHash,
      bazelBinary,
      targetQuery,
    };
    writeJsonAtomically(modelPath, model);
    return { status: 'generated', modelPath, classpathEntries: configured.classpath.length, configurationHash };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason: `Bazel project model generation failed: ${detail}` };
  }
}

function quarantineStaleModel(modelPath: string): void {
  if (!fs.existsSync(modelPath)) return;
  fs.renameSync(modelPath, `${modelPath}.stale-${Date.now()}`);
}

/** Prepare independent Bazel roots concurrently while enforcing one repository-wide budget. */
export async function prepareBazelProjectModels(
  roots: BazelPreparationRoot[],
  options: BazelPreparationOptions = {}
): Promise<BazelPreparationReport> {
  const started = Date.now();
  const candidates = roots.filter((root) => root.systems.includes('bazel'));
  const preferred = new Set(options.preferredRootIds ?? []);
  candidates.sort((left, right) => Number(preferred.has(right.id)) - Number(preferred.has(left.id)) || left.id.localeCompare(right.id));
  const requestedConcurrency = options.concurrency
    ?? positiveInteger(process.env.GITNEXUS_JDT_BAZEL_PREPARE_CONCURRENCY)
    ?? 3;
  const concurrency = Math.max(1, Math.min(
    candidates.length || 1,
    requestedConcurrency
  ));
  const timeoutMs = options.timeoutMs
    ?? positiveInteger(process.env.GITNEXUS_JDT_BAZEL_PREPARE_TIMEOUT_MS)
    ?? 10 * 60_000;
  const deadlineAt = started + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const generate = options.generate ?? ensureBazelProjectModel;
  const results: BazelRootPreparationResult[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const root = candidates[index];
      const rootStarted = Date.now();
      let result: BazelModelGenerationResult;
      try {
        result = await generate(root.workspacePath, { signal: controller.signal, deadlineAt });
      } catch (error) {
        result = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      results.push({ ...result, rootId: root.id, workspacePath: root.workspacePath, durationMs: Date.now() - rootStarted });
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    clearTimeout(timer);
  }

  const completed = new Set(results.map((result) => result.rootId));
  for (const root of candidates) {
    if (!completed.has(root.id)) {
      results.push({
        rootId: root.id,
        workspacePath: root.workspacePath,
        status: 'failed',
        reason: `Repository-wide Bazel preparation exceeded ${timeoutMs} ms.`,
        durationMs: 0,
      });
    }
  }
  results.sort((left, right) => left.rootId.localeCompare(right.rootId));
  return {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    concurrency,
    timedOut: controller.signal.aborted,
    roots: results,
  };
}

function commandTimeout(perCommandTimeout: number, deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) return perCommandTimeout;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('repository-wide Bazel preparation deadline exceeded');
  return Math.max(1, Math.min(perCommandTimeout, remaining));
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasBazelWorkspaceMarker(workspacePath: string): boolean {
  return ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'].some((name) => fs.existsSync(path.join(workspacePath, name)));
}

function parseConfiguredTargets(output: string, executionRoot: string): { labels: string[]; classpath: string[] } {
  const labels = new Set<string>();
  const jars = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [label, ...artifactPaths] = line.trim().split('\t');
    if (label) labels.add(label);
    for (const artifactPath of artifactPaths) {
      if (!artifactPath.endsWith('.jar')) continue;
      const absolute = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(executionRoot, artifactPath);
      jars.add(absolute);
    }
  }
  return { labels: [...labels].sort(), classpath: [...jars].sort() };
}

function discoverSourcePaths(workspacePath: string): string[] {
  const roots = new Set<string>();
  const files = globSync('**/*.java', {
    cwd: workspacePath,
    nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/bazel-*/**', '**/node_modules/**', '**/build/**', '**/target/**'],
  });
  for (const file of files) {
    const normalized = file.split(path.sep).join('/');
    const conventional = normalized.match(/^(.*?src\/(?:main|test)\/java)(?:\/|$)/)?.[1];
    roots.add(conventional || path.posix.dirname(normalized));
  }
  return [...roots].sort();
}

function bazelConfigurationHash(workspacePath: string): string {
  const hash = createHash('sha256');
  const files = globSync(['MODULE.bazel', 'MODULE.bazel.lock', 'WORKSPACE', 'WORKSPACE.bazel', '.bazelrc', '**/BUILD', '**/BUILD.bazel'], {
    cwd: workspacePath,
    nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/bazel-*/**'],
  }).sort();
  for (const file of files) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(workspacePath, file))).update('\0');
  }
  hash.update(process.env.GITNEXUS_JDT_BAZEL_TARGETS || '').update('\0');
  return hash.digest('hex');
}

function findBazelBinary(): string | undefined {
  const override = process.env.GITNEXUS_BAZEL_BIN;
  if (override) return override;
  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  for (const name of ['bazelisk', 'bazel']) {
    for (const directory of pathEntries) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function runBazel(binary: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, { cwd, timeout, signal, maxBuffer: 32 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { killed?: boolean; stderr?: string };
    if (failure.killed || signal?.aborted) throw new Error(`timed out after ${timeout} ms`);
    throw new Error((failure.stderr || failure.message).trim());
  }
}

function readGeneratedModel(modelPath: string): GeneratedBazelModel | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as Partial<GeneratedBazelModel>;
    return value.generatedBy === 'gitnexus-bazel-cquery' && Array.isArray(value.classpath)
      ? value as GeneratedBazelModel
      : undefined;
  } catch {
    return undefined;
  }
}

function cachedResult(modelPath: string, count?: number, configurationHash?: string): BazelModelGenerationResult {
  return { status: 'cached', modelPath, classpathEntries: count, configurationHash };
}

function writeJsonAtomically(destination: string, value: unknown): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
