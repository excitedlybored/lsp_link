import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { globSync } from 'glob';
import {
  createBazelSourceInventory,
  readBazelSourceInventory,
  sourceInventoryHash,
  type BazelConfiguredTargetSources,
  type BazelCrawlSource,
  type BazelSourceInventoryComparison,
} from './bazel-source-inventory.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_MB = 256;
const MIN_MAX_BUFFER_MB = 32;
const MAX_MAX_BUFFER_MB = 2048;
const MODEL_RELATIVE_PATH = '.gitnexus/jdtls/bazel-project.json';
const SOURCE_INVENTORY_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-inventory.json';
const HANDOFF_RELATIVE_PATH = '.gitnexus/jdtls/bazel-handoff.json';
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
  handoffPath?: string;
  scopeConfigHash?: string;
}

export interface BazelTargetScope {
  includeTargetPatterns: string[];
  includeRuleKinds: string[];
  explicitTargets: string[];
  excludeTargetNamePatterns: string[];
  excludeLabels: string[];
  excludeTags: string[];
}

export interface BazelScopeExclusion { label: string; reason: string }
export interface BazelScopeResolution {
  configHash: string;
  selectorsJson: string;
  targetQuery: string;
  resolvedLabels: string[];
  excluded: BazelScopeExclusion[];
}

interface WriteBazelHandoffInput {
  workspacePath: string;
  configurationHash: string;
  modelPath: string;
  inventoryPath: string;
  inventoryHash: string;
  compileClasspath: string[];
  runtimeClasspath: string[];
  sourceJars: string[];
  handoffPath: string;
  scopeConfigHash?: string;
}

function writeBazelHandoff(input: WriteBazelHandoffInput): void {
  if (!fs.existsSync(input.modelPath)) throw new Error(`Bazel project model does not exist: ${input.modelPath}`);
  const artifacts = new Map<string, Set<BazelHandoffArtifact['kinds'][number]>>();
  const addArtifacts = (paths: string[], kind: BazelHandoffArtifact['kinds'][number]): void => {
    for (const artifactPath of paths) {
      const resolved = path.resolve(artifactPath);
      const kinds = artifacts.get(resolved) ?? new Set<BazelHandoffArtifact['kinds'][number]>();
      kinds.add(kind);
      artifacts.set(resolved, kinds);
    }
  };
  addArtifacts(input.compileClasspath, 'compile_jar');
  addArtifacts(input.runtimeClasspath, 'runtime_jar');
  addArtifacts(input.sourceJars, 'source_jar');
  const handoff: BazelPrebuiltHandoff = {
    schemaVersion: 1,
    workspacePath: path.resolve(input.workspacePath),
    configurationHash: input.configurationHash,
    generatedAt: new Date().toISOString(),
    modelPath: path.resolve(input.modelPath),
    modelHash: hashFile(input.modelPath),
    sourceInventoryPath: path.resolve(input.inventoryPath),
    sourceInventoryHash: input.inventoryHash,
    artifacts: [...artifacts].map(([artifactPath, kinds]) => ({
      path: artifactPath,
      contentHash: hashFile(artifactPath),
      kinds: [...kinds].sort(),
    })).sort((left, right) => left.path.localeCompare(right.path)),
    scopeConfigHash: input.scopeConfigHash,
  };
  writeJsonAtomically(input.handoffPath, handoff);
}

export function validatePrebuiltBazelHandoff(
  workspacePath: string,
  expectedTargetQuery?: string,
  expectedScopeConfigHash?: string,
): BazelModelGenerationResult {
  workspacePath = path.resolve(workspacePath);
  const expectedModelPath = path.resolve(
    workspacePath,
    process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL || MODEL_RELATIVE_PATH,
  );
  const handoffPath = path.resolve(
    workspacePath,
    process.env.GITNEXUS_JDT_BAZEL_HANDOFF || HANDOFF_RELATIVE_PATH,
  );
  try {
    const handoff = readBazelHandoff(handoffPath);
    if (path.resolve(handoff.workspacePath) !== workspacePath) {
      throw new Error(`handoff belongs to ${handoff.workspacePath}, not ${workspacePath}`);
    }
    if (path.resolve(handoff.modelPath) !== expectedModelPath) {
      throw new Error(`handoff model ${handoff.modelPath} is not the configured project model ${expectedModelPath}`);
    }
    validateHashedFile(handoff.modelPath, handoff.modelHash, 'project model');
    validateExistingFile(handoff.sourceInventoryPath, 'source inventory');
    const inventory = readBazelSourceInventory(handoff.sourceInventoryPath);
    if (!inventory) throw new Error(`invalid source inventory: ${handoff.sourceInventoryPath}`);
    if (expectedTargetQuery !== undefined && inventory.targetQuery !== expectedTargetQuery) {
      throw new Error(`handoff target query ${inventory.targetQuery} does not match ${expectedTargetQuery}`);
    }
    if (expectedScopeConfigHash !== undefined && inventory.scopeResolution?.configHash !== expectedScopeConfigHash) {
      throw new Error('handoff target scope does not match the configured semantic scope');
    }
    if (handoff.scopeConfigHash !== inventory.scopeResolution?.configHash) {
      throw new Error('handoff scope hash does not match the source inventory');
    }
    if (inventory.configurationHash !== handoff.configurationHash) {
      throw new Error('source inventory configuration does not match the handoff');
    }
    if (sourceInventoryHash(inventory) !== handoff.sourceInventoryHash) {
      throw new Error('source inventory semantic hash does not match the handoff');
    }
    const configurationHash = bazelConfigurationHash(workspacePath, inventory.targetQuery);
    if (handoff.configurationHash !== configurationHash) {
      throw new Error('Bazel configuration files changed after preparation');
    }

    const model = readBazelModel(handoff.modelPath);
    if (model.configurationHash !== undefined && model.configurationHash !== handoff.configurationHash) {
      throw new Error('project model configuration does not match the handoff');
    }
    if (model.sourceInventoryPath !== undefined
      && path.resolve(workspacePath, model.sourceInventoryPath) !== path.resolve(handoff.sourceInventoryPath)) {
      throw new Error('project model source inventory path does not match the handoff');
    }
    if (model.sourceInventoryHash !== undefined && model.sourceInventoryHash !== handoff.sourceInventoryHash) {
      throw new Error('project model source inventory hash does not match the handoff');
    }
    const artifacts = new Map(handoff.artifacts.map((artifact) => [path.resolve(artifact.path), artifact]));
    for (const artifact of handoff.artifacts) {
      validateHashedFile(artifact.path, artifact.contentHash, artifact.kinds.join('/'));
    }
    validateModelArtifacts(model.classpath, workspacePath, artifacts, 'compile_jar');
    validateModelArtifacts(model.runtimeClasspath, workspacePath, artifacts, 'runtime_jar');
    for (const target of inventory.targets) {
      for (const sourceJar of target.sourceJars) {
        const artifact = artifacts.get(path.resolve(sourceJar));
        if (!artifact?.kinds.includes('source_jar')) {
          throw new Error(`source JAR is absent from the handoff: ${sourceJar}`);
        }
      }
      for (const source of target.directSources) validateExistingFile(source.path, 'configured source artifact');
    }
    for (const source of inventory.sources) {
      validateHashedFile(source.path, source.contentHash, 'crawl source');
      validateHashedFile(source.analysisPath, source.contentHash, 'analysis source');
      for (const originalPath of source.originalRepositoryPaths) {
        validateHashedFile(originalPath, source.contentHash, 'repository source');
      }
      for (const association of source.configuredSourceAssociations) {
        validateHashedFile(association.path, source.contentHash, 'configured source');
      }
      for (const association of source.sourceJarAssociations) {
        const artifact = artifacts.get(path.resolve(association.sourceJarPath));
        if (!artifact?.kinds.includes('source_jar')) {
          throw new Error(`source-JAR association is absent from the handoff: ${association.sourceJarPath}`);
        }
      }
    }
    return {
      status: 'cached',
      buildMode: 'prebuilt',
      modelPath: handoff.modelPath,
      classpathEntries: model.classpath.length,
      configurationHash,
      sourceInventoryPath: handoff.sourceInventoryPath,
      sourceInventoryHash: handoff.sourceInventoryHash,
      handoffPath,
      crawlSources: inventory.sources,
      configuredTargets: inventory.targets,
      scopeResolution: inventory.scopeResolution,
      sourceInventoryComparison: inventory.comparison,
    };
  } catch (error) {
    return {
      status: 'failed',
      buildMode: 'prebuilt',
      handoffPath,
      reason: `Prebuilt Bazel handoff validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readBazelHandoff(handoffPath: string): BazelPrebuiltHandoff {
  const value = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as Partial<BazelPrebuiltHandoff>;
  if (
    value.schemaVersion !== 1
    || typeof value.workspacePath !== 'string'
    || typeof value.configurationHash !== 'string'
    || typeof value.modelPath !== 'string'
    || typeof value.modelHash !== 'string'
    || typeof value.sourceInventoryPath !== 'string'
    || typeof value.sourceInventoryHash !== 'string'
    || !Array.isArray(value.artifacts)
  ) throw new Error(`invalid or missing handoff: ${handoffPath}`);
  if (!value.artifacts.every((artifact) => typeof artifact.path === 'string'
    && typeof artifact.contentHash === 'string' && Array.isArray(artifact.kinds))) {
    throw new Error(`invalid artifact entry in handoff: ${handoffPath}`);
  }
  return value as BazelPrebuiltHandoff;
}

interface ReadBazelModel {
  classpath: string[];
  runtimeClasspath: string[];
  configurationHash?: string;
  sourceInventoryPath?: string;
  sourceInventoryHash?: string;
}

function readBazelModel(modelPath: string): ReadBazelModel {
  const value = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as Record<string, unknown>;
  if (!Array.isArray(value.classpath) || !value.classpath.every((entry) => typeof entry === 'string')) {
    throw new Error(`invalid Bazel project model: ${modelPath}`);
  }
  if (value.runtimeClasspath !== undefined
    && (!Array.isArray(value.runtimeClasspath) || !value.runtimeClasspath.every((entry) => typeof entry === 'string'))) {
    throw new Error(`invalid Bazel runtime classpath: ${modelPath}`);
  }
  for (const field of ['configurationHash', 'sourceInventoryPath', 'sourceInventoryHash'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error(`invalid Bazel project model ${field}: ${modelPath}`);
    }
  }
  return {
    classpath: value.classpath,
    runtimeClasspath: (value.runtimeClasspath as string[] | undefined) ?? [],
    configurationHash: value.configurationHash as string | undefined,
    sourceInventoryPath: value.sourceInventoryPath as string | undefined,
    sourceInventoryHash: value.sourceInventoryHash as string | undefined,
  };
}

function readModelClasspath(
  modelPath: string,
  workspacePath: string,
  field: 'classpath' | 'runtimeClasspath',
): string[] {
  return readBazelModel(modelPath)[field].map((entry) =>
    path.isAbsolute(entry) ? entry : path.resolve(workspacePath, entry)
  );
}

function validateModelArtifacts(
  entries: string[],
  workspacePath: string,
  artifacts: Map<string, BazelHandoffArtifact>,
  kind: BazelHandoffArtifact['kinds'][number],
): void {
  for (const entry of entries) {
    const resolved = path.isAbsolute(entry) ? entry : path.resolve(workspacePath, entry);
    if (!artifacts.get(resolved)?.kinds.includes(kind)) {
      throw new Error(`${kind} is absent from the handoff: ${resolved}`);
    }
  }
}

function validateHashedFile(filePath: string, expectedHash: string, description: string): void {
  validateExistingFile(filePath, description);
  if (hashFile(filePath) !== expectedHash) throw new Error(`${description} changed after preparation: ${filePath}`);
}

function validateExistingFile(filePath: string, description: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${description} is not a regular file: ${filePath}`);
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export type BazelBuildMode = 'managed' | 'prebuilt';

interface BazelHandoffArtifact {
  path: string;
  contentHash: string;
  kinds: Array<'compile_jar' | 'runtime_jar' | 'source_jar'>;
}

interface BazelPrebuiltHandoff {
  schemaVersion: 1;
  workspacePath: string;
  configurationHash: string;
  generatedAt: string;
  modelPath: string;
  modelHash: string;
  sourceInventoryPath: string;
  sourceInventoryHash: string;
  artifacts: BazelHandoffArtifact[];
  scopeConfigHash?: string;
}

export interface BazelModelGenerationResult {
  status: 'generated' | 'cached' | 'disabled' | 'failed';
  modelPath?: string;
  classpathEntries?: number;
  configurationHash?: string;
  sourceInventoryPath?: string;
  sourceInventoryHash?: string;
  handoffPath?: string;
  buildMode?: BazelBuildMode;
  crawlSources?: BazelCrawlSource[];
  configuredTargets?: BazelConfiguredTargetSources[];
  scopeResolution?: BazelScopeResolution;
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
  buildMode?: BazelBuildMode;
  targetQuery?: string;
  targetScope?: BazelTargetScope;
  scopeConfigHash?: string;
}

export interface BazelPreparationOptions {
  concurrency?: number;
  timeoutMs?: number;
  preferredRootIds?: string[];
  buildMode?: BazelBuildMode;
  targetQuery?: string;
  targetScope?: BazelTargetScope;
  scopeConfigHash?: string;
  generate?: (workspacePath: string, options: BazelModelGenerationOptions) => Promise<BazelModelGenerationResult>;
}

/** Generate the exact external model JDT.LS needs from Bazel's configured JavaInfo graph. */
export async function ensureBazelProjectModel(
  workspacePath: string,
  options: BazelModelGenerationOptions = {}
): Promise<BazelModelGenerationResult> {
  workspacePath = path.resolve(workspacePath);
  if (!hasBazelWorkspaceMarker(workspacePath)) return { status: 'disabled' };
  const buildMode = options.buildMode ?? 'managed';
  if (buildMode === 'prebuilt') {
    return validatePrebuiltBazelHandoff(
      workspacePath,
      options.targetQuery ?? process.env.GITNEXUS_JDT_BAZEL_TARGETS,
      options.scopeConfigHash,
    );
  }
  if (envBoolean('GITNEXUS_JDT_BAZEL_AUTO_MODEL') === false) return { status: 'disabled' };

  // A handoff certifies one fully completed preparation. Invalidate it before
  // starting another attempt so a later failure cannot fall back to stale,
  // previously successful artifacts during a prebuilt run.
  const handoffPath = path.resolve(
    workspacePath,
    process.env.GITNEXUS_JDT_BAZEL_HANDOFF || HANDOFF_RELATIVE_PATH,
  );
  fs.rmSync(handoffPath, { force: true });

  const configuredPath = process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL;
  const modelPath = path.resolve(workspacePath, configuredPath || MODEL_RELATIVE_PATH);
  const customModel = Boolean(configuredPath && fs.existsSync(modelPath));

  const bazelBinary = findBazelBinary();
  if (!bazelBinary) return { status: 'failed', reason: 'Neither bazelisk nor bazel was found on PATH.' };
  const timeout = positiveInteger(process.env.GITNEXUS_JDT_BAZEL_MODEL_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

  const scopeResolution = options.targetScope
    ? await resolveBazelTargetScope(workspacePath, bazelBinary, options.targetScope, options.scopeConfigHash!, timeout, options)
    : undefined;
  const targetQuery = scopeResolution?.targetQuery
    ?? options.targetQuery ?? process.env.GITNEXUS_JDT_BAZEL_TARGETS ?? '//...';
  const configurationHash = bazelConfigurationHash(workspacePath, targetQuery);
  const sourcePaths = discoverSourcePaths(workspacePath);
  const existing = readGeneratedModel(modelPath);
  if (existing && !customModel && existing.configurationHash !== configurationHash) quarantineStaleModel(modelPath);

  // Provider-based filtering is deliberate: custom/Starlark Java rules need not
  // have a native `java_*` rule kind, but JavaInfo is the stable contract.
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
      current.ruleKind = target.ruleKind;
      current.dependencies = target.dependencies;
      targetMap.set(target.label, current);
    }
    for (const [label, jars] of sourceJars) {
      const current = targetMap.get(label) ?? { label, directSources: [], sourceJars: [] };
      current.sourceJars.push(...jars);
      targetMap.set(label, current);
    }
    for (const [label, artifacts] of configured.artifactsByLabel) {
      const current = targetMap.get(label) ?? { label, directSources: [], sourceJars: [] };
      current.compileArtifacts = artifacts;
      targetMap.set(label, current);
    }
    for (const [label, artifacts] of runtime.artifactsByLabel) {
      const current = targetMap.get(label) ?? { label, directSources: [], sourceJars: [] };
      current.runtimeArtifacts = artifacts;
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
      scopeResolution,
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
      handoffPath,
      scopeConfigHash: scopeResolution?.configHash,
    };
    if (!customModel) writeJsonAtomically(modelPath, model);
    writeBazelHandoff({
      workspacePath,
      configurationHash,
      modelPath,
      inventoryPath,
      inventoryHash,
      compileClasspath: customModel ? readModelClasspath(modelPath, workspacePath, 'classpath') : configured.classpath,
      runtimeClasspath: customModel ? readModelClasspath(modelPath, workspacePath, 'runtimeClasspath') : runtime.classpath,
      sourceJars: [...targetMap.values()].flatMap((target) => target.sourceJars),
      handoffPath,
      scopeConfigHash: scopeResolution?.configHash,
    });
    return {
      status: customModel ? 'cached' : 'generated',
      modelPath,
      classpathEntries: customModel ? customClasspathCount(modelPath) : configured.classpath.length,
      configurationHash,
      sourceInventoryPath: inventoryPath,
      sourceInventoryHash: inventoryHash,
      handoffPath,
      buildMode,
      crawlSources: inventory.sources,
      configuredTargets: inventory.targets,
      sourceInventoryComparison: inventory.comparison,
      scopeResolution,
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
        result = await generate(root.workspacePath, {
          signal: controller.signal,
          deadlineAt,
          buildMode: options.buildMode ?? 'managed',
          targetQuery: options.targetQuery,
          targetScope: options.targetScope,
          scopeConfigHash: options.scopeConfigHash,
        });
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
    '    dependencies = []',
    '    if hasattr(ctx.rule.attr, "srcs"):',
    '        for source_target in ctx.rule.attr.srcs:',
    '            for source in source_target.files.to_list():',
    '                sources.append({"path": source.path, "shortPath": source.short_path, "isSource": source.is_source})',
    '    for attribute in ["deps", "exports", "runtime_deps", "plugins"]:',
    '        if hasattr(ctx.rule.attr, attribute):',
    '            for dependency in getattr(ctx.rule.attr, attribute):',
    '                dependencies.append({"label": str(dependency.label), "attribute": attribute})',
    `    output = ctx.actions.declare_file(ctx.label.name + "${ASPECT_MANIFEST_SUFFIX}")`,
    '    ctx.actions.write(output, json.encode({"label": str(ctx.label), "ruleKind": ctx.rule.kind, "sources": sources, "dependencies": dependencies}))',
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
      ruleKind?: unknown;
      dependencies?: Array<{ label?: unknown; attribute?: unknown }>;
      sources?: Array<{ path?: unknown; shortPath?: unknown; isSource?: unknown }>;
    };
    if (typeof value.label !== 'string' || !Array.isArray(value.sources)) {
      throw new Error(`Invalid Bazel source aspect manifest: ${manifestPath}`);
    }
    return {
      label: value.label,
      ruleKind: typeof value.ruleKind === 'string' ? value.ruleKind : undefined,
      dependencies: (value.dependencies ?? []).flatMap((dependency) =>
        typeof dependency.label === 'string'
          && ['deps', 'exports', 'runtime_deps', 'plugins'].includes(String(dependency.attribute))
          ? [{
            label: dependency.label,
            attribute: dependency.attribute as NonNullable<BazelConfiguredTargetSources['dependencies']>[number]['attribute'],
          }]
          : []),
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

function parseConfiguredTargets(output: string, executionRoot: string): {
  labels: string[];
  classpath: string[];
  artifactsByLabel: Map<string, string[]>;
} {
  const labels = new Set<string>();
  const jars = new Set<string>();
  const artifactsByLabel = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const [label, ...artifactPaths] = line.trim().split('\t');
    if (label) labels.add(label);
    const targetArtifacts: string[] = [];
    for (const artifactPath of artifactPaths) {
      if (!artifactPath.endsWith('.jar')) continue;
      const absolute = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(executionRoot, artifactPath);
      jars.add(absolute);
      targetArtifacts.push(absolute);
    }
    if (label) artifactsByLabel.set(label, [...new Set(targetArtifacts)].sort());
  }
  return { labels: [...labels].sort(), classpath: [...jars].sort(), artifactsByLabel };
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

function bazelConfigurationHash(workspacePath: string, targetQuery: string): string {
  const hash = createHash('sha256');
  const files = globSync([
    'MODULE.bazel', 'MODULE.bazel.lock', 'WORKSPACE', 'WORKSPACE.bazel', 'REPO.bazel',
    '.bazelrc', '.bazelversion', '.bazelignore',
    '**/BUILD', '**/BUILD.bazel', '**/*.bzl', '**/REPO.bazel', '**/.bazelrc',
  ], {
    cwd: workspacePath,
    nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/bazel-*/**'],
  }).sort();
  for (const file of files) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(workspacePath, file))).update('\0');
  }
  hash.update(targetQuery).update('\0');
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

export async function resolveBazelTargetScope(
  workspacePath: string,
  bazelBinary: string,
  scope: BazelTargetScope,
  configHash: string,
  timeout: number,
  options: Pick<BazelModelGenerationOptions, 'signal' | 'deadlineAt'> = {},
): Promise<BazelScopeResolution> {
  const candidates = new Map<string, string>();
  const exclusions = new Map<string, string>();
  for (const targetPattern of scope.includeTargetPatterns) {
    const output = await runBazel(bazelBinary, ['query', targetPattern, '--output=label_kind'], workspacePath,
      commandTimeout(timeout, options.deadlineAt), options.signal);
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^(.*?) rule (\S+)$/);
      if (match) candidates.set(match[2]!, match[1]!);
    }
    for (const tag of scope.excludeTags) {
      const tagged = await runBazel(bazelBinary, [
        'query', `attr("tags", "${escapeBazelQueryString(escapeRegex(tag))}", ${targetPattern})`, '--output=label',
      ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal);
      for (const label of tagged.split(/\r?\n/).filter(Boolean)) exclusions.set(label, `tag:${tag}`);
    }
  }
  for (const label of scope.explicitTargets) {
    const output = await runBazel(bazelBinary, ['query', label, '--output=label_kind'], workspacePath,
      commandTimeout(timeout, options.deadlineAt), options.signal);
    const line = output.split(/\r?\n/).find(Boolean);
    const match = line?.match(/^(.*?) rule (\S+)$/);
    if (!match || match[2] !== label) throw new Error(`Explicit Bazel target was not resolved: ${label}`);
    candidates.set(label, match[1]!);
  }
  const allowedKinds = new Set(scope.includeRuleKinds);
  const explicit = new Set(scope.explicitTargets);
  const exactExcludes = new Set(scope.excludeLabels);
  const namePatterns = scope.excludeTargetNamePatterns.map((pattern) => new RegExp(pattern));
  for (const [label, kind] of candidates) {
    if (!allowedKinds.has(kind) && !explicit.has(label)) exclusions.set(label, `rule-kind:${kind}`);
    if (exactExcludes.has(label)) exclusions.set(label, 'explicit-label');
    const targetName = label.includes(':') ? label.slice(label.lastIndexOf(':') + 1) : label.slice(label.lastIndexOf('/') + 1);
    const pattern = namePatterns.find((candidate) => candidate.test(targetName));
    if (pattern) exclusions.set(label, `target-name:${pattern.source}`);
  }
  const resolvedLabels = [...candidates.keys()].filter((label) => !exclusions.has(label)).sort();
  if (resolvedLabels.length === 0) throw new Error('Configured Bazel target scope resolved to no targets');
  return {
    configHash,
    selectorsJson: JSON.stringify(scope),
    targetQuery: `set(${resolvedLabels.join(' ')})`,
    resolvedLabels,
    excluded: [...exclusions].map(([label, reason]) => ({ label, reason }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

function escapeBazelQueryString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runBazel(binary: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, {
      cwd,
      timeout,
      signal,
      maxBuffer: bazelMaxBufferBytes(),
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { killed?: boolean; stderr?: string };
    if (failure.killed || signal?.aborted) throw new Error(`timed out after ${timeout} ms`);
    const stderr = failure.stderr?.trim();
    const detail = stderr && !failure.message.includes(stderr)
      ? `${failure.message.trim()}\n${stderr}`
      : failure.message.trim();
    throw new Error(detail);
  }
}

function bazelMaxBufferBytes(): number {
  const configured = process.env.GITNEXUS_BAZEL_MAX_BUFFER_MB;
  if (configured === undefined) return DEFAULT_MAX_BUFFER_MB * 1024 * 1024;
  const megabytes = Number(configured);
  if (!Number.isInteger(megabytes) || megabytes < MIN_MAX_BUFFER_MB || megabytes > MAX_MAX_BUFFER_MB) {
    throw new Error(
      `GITNEXUS_BAZEL_MAX_BUFFER_MB must be an integer from ${MIN_MAX_BUFFER_MB} to ${MAX_MAX_BUFFER_MB}, got ${configured}`,
    );
  }
  return megabytes * 1024 * 1024;
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
