import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { globSync } from 'glob';
import {
  createBazelSourceInventory,
  sourceInventoryHash,
  type BazelConfiguredTargetSources,
  type BazelCrawlSource,
  type BazelSourceInventoryComparison,
} from './bazel-source-inventory.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_RELATIVE_PATH = '.gitnexus/jdtls/bazel-project.json';
const SOURCE_INVENTORY_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-inventory.json';
const ASPECT_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-aspect.bzl';
const ASPECT_MANIFEST_SUFFIX = '.gitnexus-sources.json';

interface GeneratedBazelModel {
  javaMajor?: number;
  classpath: string[];
  runtimeClasspath: string[];
  sourcePaths: string[];
  generatedSourcePaths: string[];
  generatedBy: 'gitnexus-bazel-cquery';
  generatedAt: string;
  configurationHash: string;
  bazelBinary: string;
  targetQuery: string;
  sourceInventoryPath?: string;
  sourceInventoryHash?: string;
}

export interface BazelModelGenerationResult {
  status: 'generated' | 'cached' | 'disabled' | 'failed';
  modelPath?: string;
  classpathEntries?: number;
  configurationHash?: string;
  sourceInventoryPath?: string;
  sourceInventoryHash?: string;
  crawlSources?: BazelCrawlSource[];
  sourceInventoryComparison?: BazelSourceInventoryComparison;
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
  workspacePath = path.resolve(workspacePath);
  if (envBoolean('GITNEXUS_JDT_BAZEL_AUTO_MODEL') === false) return { status: 'disabled' };
  if (!hasBazelWorkspaceMarker(workspacePath)) return { status: 'disabled' };

  const configuredPath = process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL;
  const modelPath = path.resolve(workspacePath, configuredPath || MODEL_RELATIVE_PATH);
  const customModel = Boolean(configuredPath && fs.existsSync(modelPath));

  const configurationHash = bazelConfigurationHash(workspacePath);
  const sourcePaths = discoverSourcePaths(workspacePath);
  const existing = readGeneratedModel(modelPath);
  if (existing && !customModel && existing.configurationHash !== configurationHash) quarantineStaleModel(modelPath);

  const bazelBinary = findBazelBinary();
  if (!bazelBinary) return { status: 'failed', reason: 'Neither bazelisk nor bazel was found on PATH.' };

  const timeout = positiveInteger(process.env.GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  // Provider-based filtering is deliberate: custom/Starlark Java rules need not
  // have a native `java_*` rule kind, but JavaInfo is the stable contract.
  const targetQuery = process.env.GITNEXUS_JDT_BAZEL_TARGETS || '//...';
  try {
    const executionRoot = (await runBazel(bazelBinary, ['info', 'execution_root'], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal)).trim();
    // Bazel 8 / rules_java no longer exposes this provider under the literal
    // `JavaInfo` key. Canonical keys include the defining bzl label and retain
    // `%JavaInfo` as the stable suffix across bzlmod repository versions.
    const expression = javaInfoCqueryExpression(
      '(v.compilation_info.compilation_classpath if hasattr(v, "compilation_info") else v.transitive_compile_time_jars).to_list()',
    );
    const output = await runBazel(bazelBinary, [
      'cquery', targetQuery, '--output=starlark', `--starlark:expr=${expression}`,
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    const configured = parseConfiguredTargets(output, executionRoot);
    const runtimeExpression = javaInfoCqueryExpression('v.transitive_runtime_jars.to_list()');
    const runtimeOutput = await runBazel(bazelBinary, [
      'cquery', targetQuery, '--output=starlark', `--starlark:expr=${runtimeExpression}`,
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    const runtime = parseConfiguredTargets(runtimeOutput, executionRoot);
    const sourceJarExpression = javaInfoCqueryExpression('v.source_jars');
    const sourceJarOutput = await runBazel(bazelBinary, [
      'cquery', targetQuery, '--output=starlark', `--starlark:expr=${sourceJarExpression}`,
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    const sourceJars = parseConfiguredArtifacts(sourceJarOutput, executionRoot, (artifact) =>
      artifact.endsWith('.jar') || artifact.endsWith('.srcjar')
    );
    if (configured.labels.length === 0) {
      return { status: 'failed', reason: `Bazel cquery returned no JavaInfo targets for ${targetQuery}.` };
    }
    const targetFile = path.join(workspacePath, '.gitnexus/jdtls/bazel-targets.txt');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, `${configured.labels.join('\n')}\n`);
    ensureSourceAspect(workspacePath);
    removeStaleAspectManifests(executionRoot);
    // Always ask Bazel to refresh configured sources. Bazel's own action cache
    // keeps this incremental while still noticing arbitrary generator inputs.
    await runBazel(bazelBinary, [
      'build', '--strict_java_deps=off', `--target_pattern_file=${targetFile}`,
      `--aspects=//.gitnexus/jdtls:${path.basename(ASPECT_RELATIVE_PATH)}%gitnexus_source_aspect`,
      '--output_groups=+gitnexus_source_manifest,+_direct_source_jars',
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
    const missing = [...configured.classpath, ...runtime.classpath].filter((jar) => !fs.existsSync(jar));
    if (missing.length > 0) {
      return { status: 'failed', reason: `Bazel did not materialize ${missing.length} configured Java compile-time jars.` };
    }

    const directSources = readAspectManifests(workspacePath, executionRoot);
    const manifestLabels = new Set(directSources.map((target) => target.label));
    const missingManifests = configured.labels.filter((label) => !manifestLabels.has(label));
    if (missingManifests.length > 0) {
      throw new Error(`Bazel source aspect returned no manifest for ${missingManifests.length} JavaInfo targets.`);
    }
    const targetMap = new Map<string, BazelConfiguredTargetSources>();
    for (const label of configured.labels) targetMap.set(label, { label, directSources: [], sourceJars: [] });
    for (const target of directSources) {
      const current = targetMap.get(target.label) ?? { label: target.label, directSources: [], sourceJars: [] };
      current.directSources.push(...target.directSources);
      targetMap.set(target.label, current);
    }
    for (const [label, jars] of sourceJars) {
      const current = targetMap.get(label) ?? { label, directSources: [], sourceJars: [] };
      current.sourceJars.push(...jars);
      targetMap.set(label, current);
    }
    const inventoryPath = path.join(workspacePath, SOURCE_INVENTORY_RELATIVE_PATH);
    const inventory = await createBazelSourceInventory({
      workspacePath,
      configurationHash,
      targetQuery,
      repositorySources: discoverRepositoryJavaSources(workspacePath),
      targets: [...targetMap.values()],
      extractionRoot: path.join(workspacePath, '.gitnexus', 'jdtls', 'bazel-sources', configurationHash),
    });
    const inventoryHash = sourceInventoryHash(inventory);
    writeJsonAtomically(inventoryPath, inventory);

    const model: GeneratedBazelModel = {
      classpath: configured.classpath,
      runtimeClasspath: runtime.classpath,
      sourcePaths,
      generatedSourcePaths: discoverGeneratedSourcePaths(executionRoot),
      generatedBy: 'gitnexus-bazel-cquery',
      generatedAt: new Date().toISOString(),
      configurationHash,
      bazelBinary,
      targetQuery,
      sourceInventoryPath: inventoryPath,
      sourceInventoryHash: inventoryHash,
    };
    if (!customModel) writeJsonAtomically(modelPath, model);
    return {
      status: customModel ? 'cached' : 'generated',
      modelPath,
      classpathEntries: customModel ? customClasspathCount(modelPath) : configured.classpath.length,
      configurationHash,
      sourceInventoryPath: inventoryPath,
      sourceInventoryHash: inventoryHash,
      crawlSources: inventory.sources,
      sourceInventoryComparison: inventory.comparison,
    };
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
    ?? 4;
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

function hasBazelWorkspaceMarker(workspacePath: string): boolean {
  return ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'].some((name) => fs.existsSync(path.join(workspacePath, name)));
}

function parseConfiguredArtifacts(
  output: string,
  executionRoot: string,
  accept: (artifactPath: string) => boolean,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const [label, ...artifactPaths] = line.trim().split('\t');
    if (!label) continue;
    const artifacts = artifactPaths.filter(accept)
      .map((artifact) => path.isAbsolute(artifact) ? artifact : path.resolve(executionRoot, artifact));
    result.set(label, [...new Set(artifacts)].sort());
  }
  return result;
}

function javaInfoCqueryExpression(artifacts: string): string {
  const javaInfoKeys = '[k for k in providers(target).keys() if str(k).endswith("%JavaInfo")]';
  return `"\\t".join([str(target.label)] + `
    + `[f.path for k, v in providers(target).items() if str(k).endswith("%JavaInfo") for f in ${artifacts}]) `
    + `if len(${javaInfoKeys}) > 0 else ""`;
}

function ensureSourceAspect(workspacePath: string): void {
  const aspectPath = path.join(workspacePath, ASPECT_RELATIVE_PATH);
  const buildPath = path.join(path.dirname(aspectPath), 'BUILD.bazel');
  fs.mkdirSync(path.dirname(aspectPath), { recursive: true });
  const aspect = [
    'def _gitnexus_source_aspect_impl(target, ctx):',
    '    sources = []',
    '    if hasattr(ctx.rule.attr, "srcs"):',
    '        for source_target in ctx.rule.attr.srcs:',
    '            for source in source_target.files.to_list():',
    '                sources.append({"path": source.path, "shortPath": source.short_path, "isSource": source.is_source})',
    `    output = ctx.actions.declare_file(ctx.label.name + "${ASPECT_MANIFEST_SUFFIX}")`,
    '    ctx.actions.write(output, json.encode({"label": str(ctx.label), "sources": sources}))',
    '    return [OutputGroupInfo(gitnexus_source_manifest = depset([output]))]',
    '',
    'gitnexus_source_aspect = aspect(',
    '    implementation = _gitnexus_source_aspect_impl,',
    '    attr_aspects = [],',
    ')',
    '',
  ].join('\n');
  const build = `exports_files(["${path.basename(ASPECT_RELATIVE_PATH)}"])\n`;
  if (!fs.existsSync(aspectPath) || fs.readFileSync(aspectPath, 'utf8') !== aspect) fs.writeFileSync(aspectPath, aspect);
  if (!fs.existsSync(buildPath) || fs.readFileSync(buildPath, 'utf8') !== build) fs.writeFileSync(buildPath, build);
}

function removeStaleAspectManifests(executionRoot: string): void {
  for (const manifest of globSync(`bazel-out/**/*${ASPECT_MANIFEST_SUFFIX}`, {
    cwd: executionRoot, absolute: true, nodir: true,
  })) fs.rmSync(manifest, { force: true });
}

function readAspectManifests(workspacePath: string, executionRoot: string): BazelConfiguredTargetSources[] {
  const manifests = globSync(`bazel-out/**/*${ASPECT_MANIFEST_SUFFIX}`, {
    cwd: executionRoot, absolute: true, nodir: true,
  }).sort();
  return manifests.map((manifestPath) => {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      label?: unknown;
      sources?: Array<{ path?: unknown; shortPath?: unknown; isSource?: unknown }>;
    };
    if (typeof value.label !== 'string' || !Array.isArray(value.sources)) {
      throw new Error(`Invalid Bazel source aspect manifest: ${manifestPath}`);
    }
    return {
      label: value.label,
      directSources: value.sources.map((source) => {
        if (typeof source.path !== 'string') throw new Error(`Invalid source path in ${manifestPath}`);
        const isSource = source.isSource === true;
        const shortPath = typeof source.shortPath === 'string' ? source.shortPath : undefined;
        const sourcePath = isSource && shortPath && !shortPath.startsWith('../')
          ? path.resolve(workspacePath, shortPath)
          : path.resolve(executionRoot, source.path);
        return { path: sourcePath, shortPath, isSource };
      }),
      sourceJars: [],
    };
  });
}

function discoverRepositoryJavaSources(workspacePath: string): string[] {
  try {
    const tracked = execFileSync('git', [
      '-C', workspacePath, 'ls-files', '--cached', '-z', '--', '*.java',
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return tracked.split('\0').filter(Boolean)
      .map((file) => path.resolve(workspacePath, file))
      .filter((file) => isInsideWorkspace(file, workspacePath) && fs.existsSync(file))
      .sort();
  } catch {
    // Exported source trees and disposable fixtures need a filesystem fallback.
  }
  return globSync('**/*.java', {
    cwd: workspacePath, absolute: true, nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/bazel-*/**', '**/node_modules/**', '**/build/**', '**/target/**'],
  }).sort();
}

function isInsideWorkspace(candidate: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function customClasspathCount(modelPath: string): number | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as { classpath?: unknown };
    return Array.isArray(value.classpath) ? value.classpath.length : undefined;
  } catch { return undefined; }
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

/** JavaInfo materialization may create annotation-processor and Starlark-generated Java sources. */
function discoverGeneratedSourcePaths(executionRoot: string): string[] {
  const roots = new Set<string>();
  for (const file of globSync('bazel-out/**/*.java', {
    cwd: executionRoot,
    nodir: true,
    ignore: ['**/external/**'],
  })) {
    const normalized = file.split(path.sep).join('/');
    const marker = normalized.match(/^(.*?\/(?:generated|gensrc|generated-sources)(?:\/|$))/)?.[1];
    roots.add(path.resolve(executionRoot, marker ?? path.posix.dirname(normalized)));
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
