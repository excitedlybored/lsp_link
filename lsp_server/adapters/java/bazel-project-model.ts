import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import {
  createBazelSourceInventory,
  readBazelSourceInventory,
  sourceInventoryHash,
  type BazelConfiguredTargetSources,
  type BazelCrawlSource,
  type BazelSourceInventoryComparison,
} from './bazel-source-inventory.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const PROGRESS_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BUFFER_MB = 256;
const MIN_MAX_BUFFER_MB = 32;
const MAX_MAX_BUFFER_MB = 2048;
const MODEL_RELATIVE_PATH = '.gitnexus/jdtls/bazel-project.json';
const SOURCE_INVENTORY_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-inventory.json';
const HANDOFF_RELATIVE_PATH = '.gitnexus/jdtls/bazel-handoff.json';
const ASPECT_RELATIVE_PATH = '.gitnexus/jdtls/bazel-source-aspect.bzl';
const ASPECT_MANIFEST_SUFFIX = '.gitnexus-sources.json';
const ASPECT_BEP_RELATIVE_PATH = '.gitnexus/jdtls/bazel-aspect-build.bep.json';

interface GeneratedBazelModel {
  javaMajor?: number;
  classpath: string[];
  runtimeClasspath: string[];
  sourcePaths: string[];
  generatedSourcePaths: string[];
  generatedBy: 'gitnexus-bazel-java-graph' | 'gitnexus-bazel-cquery';
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

interface BazelAspectTarget extends BazelConfiguredTargetSources {
  hasJavaInfo: boolean;
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
    const executionRoot = (await runBazel(
      bazelBinary, ['info', 'execution_root'], workspacePath,
      commandTimeout(timeout, options.deadlineAt), options.signal, 'execution-root',
    )).trim();
    // Structured scopes use the recursive aspect as the authoritative graph.
    // Raw CLI queries retain cquery compatibility, but collect all artifact
    // roles in one configured-analysis invocation instead of three.
    const legacyConfigured = scopeResolution ? undefined : parseCombinedConfiguredTargets(
      await runBazel(bazelBinary, [
        'cquery', targetQuery, '--output=starlark', `--starlark:expr=${combinedJavaInfoCqueryExpression()}`,
      ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal, 'cquery-java-artifacts'),
      executionRoot,
    );
    const rootLabels = scopeResolution?.resolvedLabels ?? legacyConfigured?.labels ?? [];
    if (rootLabels.length === 0) {
      return { status: 'failed', reason: `Bazel returned no JavaInfo targets for ${targetQuery}.` };
    }
    const targetFile = path.join(workspacePath, '.gitnexus/jdtls/bazel-targets.txt');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, `${rootLabels.join('\n')}\n`);
    ensureSourceAspect(workspacePath);
    const aspectBepPath = path.join(workspacePath, ASPECT_BEP_RELATIVE_PATH);
    fs.rmSync(aspectBepPath, { force: true });
    // Always ask Bazel to refresh configured sources. Bazel's own action cache
    // keeps this incremental while still noticing arbitrary generator inputs.
    await runBazel(bazelBinary, [
      'build', '--strict_java_deps=off', `--target_pattern_file=${targetFile}`,
      `--aspects=//.gitnexus/jdtls:${path.basename(ASPECT_RELATIVE_PATH)}%gitnexus_source_aspect`,
      '--output_groups=+gitnexus_source_manifest,+gitnexus_java_artifacts',
      `--build_event_json_file=${aspectBepPath}`,
    ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal, 'aspect-build');

    const manifestPaths = await readAspectManifestPathsFromBep(aspectBepPath, executionRoot);
    const directSources = readAspectManifests(manifestPaths, workspacePath, executionRoot);
    const manifestsByLabel = new Map(directSources.map((target) => [target.label, target]));
    const invalidRoots = rootLabels.filter((label) => !manifestsByLabel.get(label)?.hasJavaInfo);
    if (invalidRoots.length > 0) {
      throw new Error(`Bazel source aspect found ${invalidRoots.length} selected targets without JavaInfo.`);
    }
    const targetMap = new Map(directSources.map((target) => [target.label, target]));
    if (legacyConfigured) {
      for (const [label, sourceJars] of legacyConfigured.sourceJarsByLabel) {
        const target = targetMap.get(label);
        if (target && target.sourceJars.length === 0) target.sourceJars = sourceJars;
      }
    }
    const compileReachable = reachableTargetLabels(rootLabels, targetMap, new Set(['deps', 'exports', 'plugins']));
    const runtimeReachable = reachableTargetLabels(
      rootLabels, targetMap, new Set(['deps', 'exports', 'runtime_deps', 'plugins']),
    );
    const aspectCompileClasspath = uniqueSorted([...compileReachable]
      .flatMap((label) => targetMap.get(label)?.compileArtifacts ?? []));
    const aspectRuntimeClasspath = uniqueSorted([...runtimeReachable]
      .flatMap((label) => targetMap.get(label)?.runtimeArtifacts ?? []));
    const configuredClasspath = scopeResolution ? aspectCompileClasspath : legacyConfigured!.compileClasspath;
    const runtimeClasspath = scopeResolution ? aspectRuntimeClasspath : legacyConfigured!.runtimeClasspath;
    const missing = [...configuredClasspath, ...runtimeClasspath,
      ...directSources.flatMap((target) => target.sourceJars)].filter((artifact) => !fs.existsSync(artifact));
    if (missing.length > 0) {
      return { status: 'failed', reason: `Bazel did not materialize ${new Set(missing).size} configured Java artifacts.` };
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
      classpath: configuredClasspath,
      runtimeClasspath,
      sourcePaths,
      generatedSourcePaths: discoverGeneratedSourcePaths(executionRoot),
      generatedBy: 'gitnexus-bazel-java-graph',
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
      compileClasspath: customModel ? readModelClasspath(modelPath, workspacePath, 'classpath') : configuredClasspath,
      runtimeClasspath: customModel ? readModelClasspath(modelPath, workspacePath, 'runtimeClasspath') : runtimeClasspath,
      sourceJars: [...targetMap.values()].flatMap((target) => target.sourceJars),
      handoffPath,
      scopeConfigHash: scopeResolution?.configHash,
    });
    fs.rmSync(aspectBepPath, { force: true });
    return {
      status: customModel ? 'cached' : 'generated',
      modelPath,
      classpathEntries: customModel ? customClasspathCount(modelPath) : configuredClasspath.length,
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
    fs.rmSync(path.join(workspacePath, ASPECT_BEP_RELATIVE_PATH), { force: true });
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

function combinedJavaInfoCqueryExpression(): string {
  const javaInfoKeys = '[k for k in providers(target).keys() if str(k).endswith("%JavaInfo")]';
  return `"\\t".join([str(target.label)] + `
    + `["C:" + f.path for k, v in providers(target).items() if str(k).endswith("%JavaInfo") for f in (v.compilation_info.compilation_classpath if hasattr(v, "compilation_info") else v.transitive_compile_time_jars).to_list()] + `
    + `["R:" + f.path for k, v in providers(target).items() if str(k).endswith("%JavaInfo") for f in v.transitive_runtime_jars.to_list()] + `
    + `["S:" + f.path for k, v in providers(target).items() if str(k).endswith("%JavaInfo") for f in v.source_jars]) `
    + `if len(${javaInfoKeys}) > 0 else ""`;
}

function ensureSourceAspect(workspacePath: string): void {
  const aspectPath = path.join(workspacePath, ASPECT_RELATIVE_PATH);
  const buildPath = path.join(path.dirname(aspectPath), 'BUILD.bazel');
  fs.mkdirSync(path.dirname(aspectPath), { recursive: true });
  const aspect = [
    'load("@rules_java//java/common:java_info.bzl", "JavaInfo")',
    '',
    'GitNexusJavaGraphInfo = provider(fields = ["manifests", "artifacts"])',
    '',
    'def _gitnexus_source_aspect_impl(target, ctx):',
    '    sources = []',
    '    dependencies = []',
    '    transitive_manifests = []',
    '    transitive_artifacts = []',
    '    if hasattr(ctx.rule.attr, "srcs"):',
    '        for source_target in ctx.rule.attr.srcs:',
    '            for source in source_target.files.to_list():',
    '                sources.append({"path": source.path, "shortPath": source.short_path, "isSource": source.is_source})',
    '    for attribute in ["deps", "exports", "runtime_deps", "plugins"]:',
    '        if hasattr(ctx.rule.attr, attribute):',
    '            for dependency in getattr(ctx.rule.attr, attribute):',
    '                dependencies.append({"label": str(dependency.label), "attribute": attribute})',
    '                if GitNexusJavaGraphInfo in dependency:',
    '                    transitive_manifests.append(dependency[GitNexusJavaGraphInfo].manifests)',
    '                    transitive_artifacts.append(dependency[GitNexusJavaGraphInfo].artifacts)',
    '    direct_manifests = []',
    '    direct_artifacts = []',
    '    compile_jars = []',
    '    runtime_jars = []',
    '    source_jars = []',
    '    has_java_info = JavaInfo in target',
    '    if has_java_info:',
    '        java_info = target[JavaInfo]',
    '        compile_jars = java_info.compile_jars.to_list()',
    '        runtime_jars = list(java_info.runtime_output_jars)',
    '        source_jars = list(java_info.source_jars)',
    '        direct_artifacts = compile_jars + runtime_jars + source_jars',
    `    output = ctx.actions.declare_file(ctx.label.name + "${ASPECT_MANIFEST_SUFFIX}")`,
    '    ctx.actions.write(output, json.encode({',
    '            "label": str(ctx.label),',
    '            "ruleKind": ctx.rule.kind,',
    '            "hasJavaInfo": has_java_info,',
    '            "sources": sources,',
    '            "dependencies": dependencies,',
    '            "compileArtifacts": [artifact.path for artifact in compile_jars],',
    '            "runtimeArtifacts": [artifact.path for artifact in runtime_jars],',
    '            "sourceJars": [artifact.path for artifact in source_jars],',
    '    }))',
    '    direct_manifests = [output]',
    '    manifests = depset(direct = direct_manifests, transitive = transitive_manifests)',
    '    artifacts = depset(direct = direct_artifacts, transitive = transitive_artifacts)',
    '    return [',
    '        GitNexusJavaGraphInfo(manifests = manifests, artifacts = artifacts),',
    '        OutputGroupInfo(gitnexus_source_manifest = manifests, gitnexus_java_artifacts = artifacts),',
    '    ]',
    '',
    'gitnexus_source_aspect = aspect(',
    '    implementation = _gitnexus_source_aspect_impl,',
    '    attr_aspects = ["deps", "exports", "runtime_deps", "plugins"],',
    ')',
    '',
  ].join('\n');
  const build = `exports_files(["${path.basename(ASPECT_RELATIVE_PATH)}"])\n`;
  if (!fs.existsSync(aspectPath) || fs.readFileSync(aspectPath, 'utf8') !== aspect) fs.writeFileSync(aspectPath, aspect);
  if (!fs.existsSync(buildPath) || fs.readFileSync(buildPath, 'utf8') !== build) fs.writeFileSync(buildPath, build);
}

interface BepFile {
  name?: unknown;
  uri?: unknown;
  pathPrefix?: unknown;
}

interface BepNamedSet {
  files: BepFile[];
  fileSetIds: string[];
}

async function readAspectManifestPathsFromBep(bepPath: string, executionRoot: string): Promise<string[]> {
  const startedAt = Date.now();
  let lineNumber = 0;
  console.error('[bazel:aspect-output-discovery] started');
  const heartbeat = setInterval(() => {
    console.error(
      `[bazel:aspect-output-discovery] running — elapsed ${formatElapsed(Date.now() - startedAt)}; parsed ${lineNumber} events`,
    );
  }, PROGRESS_INTERVAL_MS);
  heartbeat.unref();
  try {
    if (!fs.existsSync(bepPath)) throw new Error(`Bazel did not write its Build Event Protocol file: ${bepPath}`);
    const namedSets = new Map<string, BepNamedSet>();
    const rootSetIds = new Set<string>();
    const inlineFiles: BepFile[] = [];
    const lines = createInterface({ input: fs.createReadStream(bepPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid Bazel BEP JSON at ${bepPath}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const namedSetId = event?.id?.namedSet?.id;
      if (typeof namedSetId === 'string' && event?.namedSetOfFiles && typeof event.namedSetOfFiles === 'object') {
        namedSets.set(namedSetId, {
          files: Array.isArray(event.namedSetOfFiles.files)
            ? event.namedSetOfFiles.files.filter(isPotentialManifestBepFile)
            : [],
          fileSetIds: bepFileSetIds(event.namedSetOfFiles.fileSets, bepPath, lineNumber),
        });
      }
      for (const group of Array.isArray(event?.completed?.outputGroup) ? event.completed.outputGroup : []) {
        if (group?.name !== 'gitnexus_source_manifest') continue;
        if (group.incomplete === true) throw new Error('Bazel reported an incomplete gitnexus_source_manifest output group.');
        for (const id of bepFileSetIds(group.fileSets, bepPath, lineNumber)) rootSetIds.add(id);
        if (Array.isArray(group.inlineFiles)) inlineFiles.push(...group.inlineFiles);
      }
    }
    if (rootSetIds.size === 0 && inlineFiles.length === 0) {
      throw new Error('Bazel BEP contained no gitnexus_source_manifest output group.');
    }
    const files = [...inlineFiles];
    const pending = [...rootSetIds];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const namedSet = namedSets.get(id);
      if (!namedSet) throw new Error(`Bazel BEP referenced missing NamedSetOfFiles ${JSON.stringify(id)}.`);
      files.push(...namedSet.files);
      pending.push(...namedSet.fileSetIds);
    }
    const manifests = uniqueSorted(files.flatMap((file) => {
      const resolved = resolveBepFile(file, executionRoot);
      if (!resolved || !resolved.endsWith(ASPECT_MANIFEST_SUFFIX)) return [];
      if (!isInsideWorkspace(resolved, executionRoot)) {
        throw new Error(`Bazel BEP manifest is outside the execution root: ${resolved}`);
      }
      return [resolved];
    }));
    if (manifests.length === 0) throw new Error('Bazel BEP reported no source-aspect manifest files.');
    console.error(
      `[bazel:aspect-output-discovery] completed in ${formatElapsed(Date.now() - startedAt)}; resolved ${manifests.length} manifests`,
    );
    return manifests;
  } finally {
    clearInterval(heartbeat);
  }
}

function isPotentialManifestBepFile(file: BepFile): boolean {
  return (typeof file.name === 'string' && file.name.endsWith(ASPECT_MANIFEST_SUFFIX))
    || (typeof file.uri === 'string' && file.uri.includes(ASPECT_MANIFEST_SUFFIX));
}

function bepFileSetIds(value: unknown, bepPath: string, lineNumber: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid BEP fileSets at ${bepPath}:${lineNumber}.`);
  return value.map((fileSet) => {
    if (!fileSet || typeof fileSet.id !== 'string') {
      throw new Error(`Invalid BEP NamedSetOfFiles reference at ${bepPath}:${lineNumber}.`);
    }
    return fileSet.id;
  });
}

function resolveBepFile(file: BepFile, executionRoot: string): string | undefined {
  if (typeof file.uri === 'string') {
    try {
      const url = new URL(file.uri);
      if (url.protocol === 'file:') return path.resolve(fileURLToPath(url));
    } catch {
      // Fall through to the portable pathPrefix/name representation.
    }
  }
  if (typeof file.name !== 'string') return undefined;
  if (file.pathPrefix !== undefined
    && (!Array.isArray(file.pathPrefix) || file.pathPrefix.some((part) => typeof part !== 'string'))) {
    throw new Error('Invalid Bazel BEP file pathPrefix.');
  }
  return path.resolve(executionRoot, ...((file.pathPrefix as string[] | undefined) ?? []), file.name);
}

function readAspectManifests(
  manifests: string[], workspacePath: string, executionRoot: string,
): BazelAspectTarget[] {
  const startedAt = Date.now();
  console.error(`[bazel:aspect-manifest-read] started; reading ${manifests.length} manifests`);
  const targets = manifests.map((manifestPath) => {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      label?: unknown;
      ruleKind?: unknown;
      dependencies?: Array<{ label?: unknown; attribute?: unknown }>;
      sources?: Array<{ path?: unknown; shortPath?: unknown; isSource?: unknown }>;
      compileArtifacts?: unknown;
      runtimeArtifacts?: unknown;
      sourceJars?: unknown;
      hasJavaInfo?: unknown;
    };
    if (typeof value.label !== 'string' || !Array.isArray(value.sources)) {
      throw new Error(`Invalid Bazel source aspect manifest: ${manifestPath}`);
    }
    return {
      label: value.label,
      // Missing only in hand-written legacy fixtures/manifests.
      hasJavaInfo: value.hasJavaInfo === undefined ? true : value.hasJavaInfo === true,
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
      compileArtifacts: resolveManifestArtifacts(value.compileArtifacts, executionRoot, manifestPath),
      runtimeArtifacts: resolveManifestArtifacts(value.runtimeArtifacts, executionRoot, manifestPath),
      sourceJars: resolveManifestArtifacts(value.sourceJars, executionRoot, manifestPath),
    };
  });
  console.error(
    `[bazel:aspect-manifest-read] completed in ${formatElapsed(Date.now() - startedAt)}; read ${targets.length} manifests`,
  );
  return targets;
}

function resolveManifestArtifacts(value: unknown, executionRoot: string, manifestPath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((artifact) => typeof artifact !== 'string')) {
    throw new Error(`Invalid artifact paths in ${manifestPath}`);
  }
  return uniqueSorted(value.map((artifact) => path.isAbsolute(artifact as string)
    ? artifact as string
    : path.resolve(executionRoot, artifact as string)));
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

function parseCombinedConfiguredTargets(output: string, executionRoot: string): {
  labels: string[];
  compileClasspath: string[];
  runtimeClasspath: string[];
  sourceJarsByLabel: Map<string, string[]>;
} {
  const labels = new Set<string>();
  const compileJars = new Set<string>();
  const runtimeJars = new Set<string>();
  const sourceJarsByLabel = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const [label, ...records] = line.trim().split('\t');
    if (label) labels.add(label);
    const targetSourceJars: string[] = [];
    for (const record of records) {
      const role = record.slice(0, 2);
      const artifactPath = record.slice(2);
      const acceptedArtifact = role === 'S:'
        ? artifactPath.endsWith('.jar') || artifactPath.endsWith('.srcjar')
        : artifactPath.endsWith('.jar');
      if (!['C:', 'R:', 'S:'].includes(role) || !acceptedArtifact) continue;
      const absolute = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(executionRoot, artifactPath);
      if (role === 'C:') compileJars.add(absolute);
      else if (role === 'R:') runtimeJars.add(absolute);
      else targetSourceJars.push(absolute);
    }
    if (label) sourceJarsByLabel.set(label, uniqueSorted(targetSourceJars));
  }
  return {
    labels: [...labels].sort(),
    compileClasspath: [...compileJars].sort(),
    runtimeClasspath: [...runtimeJars].sort(),
    sourceJarsByLabel,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function reachableTargetLabels(
  roots: string[],
  targets: Map<string, BazelConfiguredTargetSources>,
  attributes: Set<NonNullable<BazelConfiguredTargetSources['dependencies']>[number]['attribute']>,
): Set<string> {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const label = pending.pop()!;
    if (reachable.has(label)) continue;
    reachable.add(label);
    for (const dependency of targets.get(label)?.dependencies ?? []) {
      if (attributes.has(dependency.attribute)) pending.push(dependency.label);
    }
  }
  return reachable;
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
  for (const [patternIndex, targetPattern] of scope.includeTargetPatterns.entries()) {
    const output = await runBazel(bazelBinary, ['query', targetPattern, '--output=label_kind'], workspacePath,
      commandTimeout(timeout, options.deadlineAt), options.signal,
      `scope-discovery-${patternIndex + 1}-of-${scope.includeTargetPatterns.length}`);
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^(.*?) rule (\S+)$/);
      if (match) candidates.set(match[2]!, match[1]!);
    }
    for (const tag of scope.excludeTags) {
      const tagged = await runBazel(bazelBinary, [
        'query', `attr("tags", "${escapeBazelQueryString(escapeRegex(tag))}", ${targetPattern})`, '--output=label',
      ], workspacePath, commandTimeout(timeout, options.deadlineAt), options.signal, `scope-tag-exclusion-${tag}`);
      for (const label of tagged.split(/\r?\n/).filter(Boolean)) exclusions.set(label, `tag:${tag}`);
    }
  }
  for (const [targetIndex, label] of scope.explicitTargets.entries()) {
    const output = await runBazel(bazelBinary, ['query', label, '--output=label_kind'], workspacePath,
      commandTimeout(timeout, options.deadlineAt), options.signal,
      `scope-explicit-target-${targetIndex + 1}-of-${scope.explicitTargets.length}`);
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
  console.error(
    `[bazel:scope] resolved ${resolvedLabels.length} selected targets; ${exclusions.size} excluded`,
  );
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

async function runBazel(
  binary: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  progressLabel = args[0] ?? 'command',
): Promise<string> {
  const maxBytes = bazelMaxBufferBytes();
  const startedAt = Date.now();
  console.error(`[bazel:${progressLabel}] started`);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let latestStatus = '';
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let settled = false;

    const cleanup = (): void => {
      clearInterval(heartbeat);
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', abortListener);
    };
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(output ?? '');
    };
    const stop = (): void => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const abortListener = (): void => {
      aborted = true;
      stop();
    };
    const record = (chunks: Buffer[], chunk: Buffer, isStderr: boolean): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        overflow = true;
        stop();
        return;
      }
      chunks.push(chunk);
      if (isStderr) {
        const lines = stripAnsi(chunk.toString('utf8')).split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) latestStatus = lines.at(-1)!.slice(0, 240);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => record(stdout, chunk, false));
    child.stderr.on('data', (chunk: Buffer) => record(stderr, chunk, true));
    child.on('error', (error) => finish(error));
    child.on('close', (code, closeSignal) => {
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (timedOut) return finish(new Error(`Bazel ${progressLabel} timed out after ${timeout} ms`));
      if (aborted || signal?.aborted) return finish(new Error(`Bazel ${progressLabel} was aborted`));
      if (overflow) {
        return finish(new Error(
          `Bazel ${progressLabel} output exceeded ${formatBytes(maxBytes)}; increase GITNEXUS_BAZEL_MAX_BUFFER_MB`,
        ));
      }
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        const exit = closeSignal ? `signal ${closeSignal}` : `exit code ${String(code)}`;
        return finish(new Error(`Bazel ${progressLabel} failed with ${exit}${stderrText ? `\n${stderrText}` : ''}`));
      }
      console.error(
        `[bazel:${progressLabel}] completed in ${elapsed}; captured ${formatBytes(outputBytes)}`,
      );
      return finish(undefined, Buffer.concat(stdout).toString('utf8'));
    });

    const heartbeat = setInterval(() => {
      const status = latestStatus ? `; latest: ${latestStatus}` : '';
      console.error(
        `[bazel:${progressLabel}] running — elapsed ${formatElapsed(Date.now() - startedAt)}; captured ${formatBytes(outputBytes)}${status}`,
      );
    }, PROGRESS_INTERVAL_MS);
    heartbeat.unref();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    timeoutHandle.unref();
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) abortListener();
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
    return ['gitnexus-bazel-java-graph', 'gitnexus-bazel-cquery'].includes(String(value.generatedBy))
      && Array.isArray(value.classpath)
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
