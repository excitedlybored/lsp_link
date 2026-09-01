import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import {
  jdtlsHeapGigabytes,
  jdtlsResolutionClasspath,
  usesNativeJdtImport,
  JdtlsWorkspace,
  type JavaBuildRoot,
} from './jdtls-runtime.js';
import {
  readBazelSourceInventory,
  sourceInventoryHash,
  type BazelCrawlSource,
} from './bazel-source-inventory.js';

export type JdtlsSourceLayout = 'linked' | 'copied';

export interface JdtlsSourceMapping {
  sourcePath: string;
  analysisPath: string;
  sourceRoot: string;
}

export interface JdtlsSourceUriAlias {
  sourcePath: string;
  physicalPath: string;
  logicalPath: string;
}

export interface JdtlsProjectModel {
  buildRootId: string;
  projectName: string;
  buildRootPath: string;
  sourcePaths: string[];
  generatedSourcePaths: string[];
  sourceMappings: JdtlsSourceMapping[];
  sourceLayout: JdtlsSourceLayout;
  sourceInventoryHash?: string;
  consolidatedSourceRoots: string[];
  uriAliases: JdtlsSourceUriAlias[];
  compileClasspath: string[];
  runtimeClasspath: string[];
  languageServerClasspath: string[];
  javaMajor?: number;
  buildSystems: string[];
  configurationHash?: string;
  modelSource: 'bazel-java-info' | 'eclipse-classpath' | 'source-discovery';
  projectImportMode: 'native-build-tool' | 'external-eclipse';
  /** Physical root of the generated Eclipse project used for project-scoped commands. */
  eclipseProjectPath?: string;
  representativeDocumentPath?: string;
}

export interface JdtlsBuildRootShard {
  id: string;
  roots: JavaBuildRoot[];
  sourceFileCount: number;
}

export interface PreparedJdtlsShard extends JdtlsBuildRootShard {
  workspacePath: string;
  projectModels: JdtlsProjectModel[];
  cacheLeasePaths: string[];
}

export interface JdtlsShardPreparationProgress {
  phase: 'loading-model' | 'mapping-sources' | 'cache-validation' | 'cache-hit' | 'cache-build'
    | 'consolidating-sources' | 'cache-finalization' | 'cache-pruning' | 'model-finalization'
    | 'staging-sources' | 'link-project' | 'complete';
  completed?: number;
  total?: number;
}

interface ConsolidatedCacheEntry {
  sourcePath: string;
  inputPath: string;
  contentHash: string;
  relativePath: string;
  sourceRootRelative: string;
}

interface ConsolidatedCacheManifest {
  schemaVersion: 1;
  sourceInventoryHash: string;
  createdAt: string;
  entries: Array<Omit<ConsolidatedCacheEntry, 'inputPath'>>;
}

interface InventorySourcePreparation {
  mappings: JdtlsSourceMapping[];
  cacheRoot?: string;
  cacheLeasePath?: string;
}

const CONSOLIDATION_THRESHOLD = 128;
const CONSOLIDATED_SOURCE_BUCKETS = 64;
const CACHE_MANIFEST = '.complete.json';
const CACHE_LEASES = '.leases';
const cacheLeaseByModel = new WeakMap<JdtlsProjectModel, string>();

/** Deterministic least-loaded allocation keeps exactly one owner for every build root. */
export function planJdtlsBuildRootShards(
  roots: JavaBuildRoot[],
  shardCount = 4,
  sourceCounts?: Map<string, number>,
): JdtlsBuildRootShard[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('JDT LS shard count must be positive');
  const count = Math.min(shardCount, Math.max(roots.length, 1));
  const shards = Array.from({ length: count }, (_, index): JdtlsBuildRootShard => ({
    id: `jdtls-shard-${index + 1}`,
    roots: [],
    sourceFileCount: 0,
  }));
  const weighted = roots.map((root) => ({ root, weight: sourceCounts?.get(root.id) ?? countJavaSources(root) }))
    .sort((left, right) => right.weight - left.weight || left.root.id.localeCompare(right.root.id));
  for (const item of weighted) {
    const shard = [...shards].sort((left, right) =>
      left.sourceFileCount - right.sourceFileCount
      || left.roots.length - right.roots.length
      || left.id.localeCompare(right.id))[0];
    shard.roots.push(item.root);
    shard.sourceFileCount += item.weight;
  }
  for (const shard of shards) shard.roots.sort((left, right) => left.id.localeCompare(right.id));
  return shards;
}

/** Reduce process count until the aggregate configured JVM heap fits the repository budget. */
export function planJdtlsBuildRootShardsWithinBudget(
  roots: JavaBuildRoot[],
  requestedShardCount: number,
  sourceCounts: Map<string, number>,
  maxTotalHeapGb: number,
): JdtlsBuildRootShard[] {
  if (!Number.isFinite(maxTotalHeapGb) || maxTotalHeapGb < 2) {
    throw new Error('JDT LS total heap budget must be at least 2 GB');
  }
  for (let count = Math.min(requestedShardCount, Math.max(roots.length, 1)); count >= 1; count -= 1) {
    const plan = planJdtlsBuildRootShards(roots, count, sourceCounts);
    const heap = plan.reduce((total, shard) => total + jdtlsHeapGigabytes(shard.sourceFileCount), 0);
    if (heap <= maxTotalHeapGb || count === 1) return plan;
  }
  return planJdtlsBuildRootShards(roots, 1, sourceCounts);
}

/** Materialize staged Eclipse projects consumed by one persistent JDT LS process. */
export function prepareJdtlsShardWorkspace(
  repositoryPath: string,
  shard: JdtlsBuildRootShard,
  sessionId = `${process.pid}-${randomUUID()}`,
  progress?: (event: JdtlsShardPreparationProgress) => void,
): PreparedJdtlsShard {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error('Invalid JDT LS workspace session id');
  const sourceLayout = jdtlsSourceLayout();
  const repositoryHash = createHash('sha256').update(path.resolve(repositoryPath)).digest('hex').slice(0, 16);
  // Eclipse persists project locations using canonical filesystem paths. On
  // macOS, /tmp is a symlink to /private/tmp; constructing client URIs from
  // the non-canonical spelling makes JDTUtils miss the imported IProject and
  // silently place the document in its classpath-less invisible project.
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  pruneStaleJdtlsWorkspaces(path.join(temporaryRoot, 'gitnexus-jdt-projects', repositoryHash));
  const workspacePath = path.join(
    temporaryRoot, 'gitnexus-jdt-projects', repositoryHash, sessionId, shard.id,
  );
  fs.mkdirSync(workspacePath, { recursive: true });
  // Shard membership may change as roots are added or rebalanced. Generated
  // projects are disposable; remove stale members so they cannot leak into a
  // later JDT process using the same shard id.
  fs.rmSync(path.join(workspacePath, 'projects'), { recursive: true, force: true });
  const cacheLeaseId = `${sessionId}-${shard.id}`;
  progress?.({ phase: 'loading-model', completed: 0, total: shard.roots.length });
  const projectModels: JdtlsProjectModel[] = [];
  try {
    for (let index = 0; index < shard.roots.length; index += 1) {
      projectModels.push(loadProjectModel(shard.roots[index], sourceLayout, cacheLeaseId, progress));
      progress?.({ phase: 'loading-model', completed: index + 1, total: shard.roots.length });
    }
    for (const model of projectModels) {
      if (model.projectImportMode === 'external-eclipse') writeEclipseProject(workspacePath, model, progress);
    }
    const manifest = {
      schemaVersion: 1,
      shardId: shard.id,
      generatedAt: new Date().toISOString(),
      projects: projectModels,
    };
    writeJsonAtomically(path.join(workspacePath, 'gitnexus-jdtls-shard.json'), manifest);
    progress?.({ phase: 'complete' });
    return {
      ...shard,
      workspacePath,
      projectModels,
      cacheLeasePaths: projectModels.flatMap((model) => modelCacheLeasePaths(model)),
    };
  } catch (error) {
    for (const model of projectModels) {
      for (const leasePath of modelCacheLeasePaths(model)) fs.rmSync(leasePath, { force: true });
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

/** Remove abandoned sessions without touching a process that is still alive. */
export function pruneStaleJdtlsWorkspaces(repositoryTemporaryRoot: string): void {
  if (!fs.existsSync(repositoryTemporaryRoot)) return;
  const staleUnknownAgeMs = 24 * 60 * 60 * 1_000;
  for (const entry of fs.readdirSync(repositoryTemporaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(repositoryTemporaryRoot, entry.name);
    const match = /^(\d+)-/.exec(entry.name);
    if (match) {
      if (!processExists(Number(match[1]))) fs.rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    // Old layouts did not carry a PID. Only reap them after a generous age so
    // an older compatible indexer cannot lose a workspace it still owns.
    try {
      if (Date.now() - fs.statSync(entryPath).mtimeMs > staleUnknownAgeMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    } catch { /* a concurrent cleanup already removed it */ }
  }
}

/** Remove only the run-scoped generated workspace owned by this prepared shard. */
export function cleanupJdtlsShardWorkspace(shard: PreparedJdtlsShard): void {
  try {
    fs.rmSync(shard.workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } finally {
    for (const leasePath of shard.cacheLeasePaths) fs.rmSync(leasePath, { force: true });
  }
  const sessionDirectory = path.dirname(shard.workspacePath);
  try { fs.rmdirSync(sessionDirectory); } catch { /* another shard still owns the session */ }
}

function loadProjectModel(
  root: JavaBuildRoot,
  sourceLayout: JdtlsSourceLayout,
  cacheLeaseId: string,
  progress?: (event: JdtlsShardPreparationProgress) => void,
): JdtlsProjectModel {
  const bazelModelPath = path.resolve(
    root.workspacePath,
    process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL ?? '.gitnexus/jdtls/bazel-project.json',
  );
  const bazel = readJson(bazelModelPath) as {
    sourcePaths?: unknown; generatedSourcePaths?: unknown; classpath?: unknown; runtimeClasspath?: unknown;
    javaMajor?: unknown; configurationHash?: unknown; sourceInventoryPath?: unknown; sourceInventoryHash?: unknown;
  } | undefined;
  const configuredInventoryPath = typeof bazel?.sourceInventoryPath === 'string'
    ? path.resolve(root.workspacePath, bazel.sourceInventoryPath)
    : path.join(root.workspacePath, '.gitnexus', 'jdtls', 'bazel-source-inventory.json');
  const sourceInventory = readBazelSourceInventory(configuredInventoryPath);
  const inventoryHash = sourceInventory ? sourceInventoryHash(sourceInventory) : undefined;
  const sourcePreparation = sourceInventory && inventoryHash
    ? sourceMappingsForInventory(
      sourceInventory.sources,
      sourceInventory.workspacePath,
      sourceInventory.configurationHash,
      inventoryHash,
      cacheLeaseId,
      progress,
    )
    : { mappings: [] };
  const sourceMappings = sourcePreparation.mappings;
  progress?.({ phase: 'model-finalization', completed: 0, total: 1 });
  const sourcePaths = stringArray(bazel?.sourcePaths).map((entry) => path.resolve(root.workspacePath, entry));
  const generatedSourcePaths = stringArray(bazel?.generatedSourcePaths)
    .map((entry) => path.resolve(root.workspacePath, entry));
  const bazelClasspath = stringArray(bazel?.classpath)
    .map((entry) => path.resolve(root.workspacePath, entry)).filter(fs.existsSync);
  const runtimeClasspath = stringArray(bazel?.runtimeClasspath)
    .map((entry) => path.resolve(root.workspacePath, entry)).filter(fs.existsSync);
  // The validated Bazel inventory is authoritative. Recursively discovering
  // fallback sources here rescans a large monorepo immediately after its exact
  // source inventory was consolidated.
  const needsEclipseFallback = (sourceMappings.length === 0 && sourcePaths.length === 0)
    || bazelClasspath.length === 0;
  const eclipse = needsEclipseFallback
    ? readEclipseClasspath(root.workspacePath)
    : { sources: [], libraries: [] };
  const discovered = sourceInventory
    ? { sourcePaths: [], generatedSourcePaths: [] }
    : discoverSourcePaths(root.workspacePath);
  const compileClasspath = bazelClasspath.length > 0 ? bazelClasspath : eclipse.libraries;
  const languageServerClasspath = bazelClasspath.length > 0
    ? jdtlsResolutionClasspath({ classpath: bazelClasspath, runtimeClasspath })
    : compileClasspath;
  // Never let a build-root id become the leading project-name token. JDT's
  // standard resource filters include `bazel-.*`; a project named after a
  // `bazel:` root is imported but all of its source resources are hidden.
  const projectName = `gitnexus-${safeName(root.id)}-${createHash('sha256').update(root.id).digest('hex').slice(0, 8)}`;
  const inspectedJavaMajor = typeof bazel?.javaMajor === 'number'
    ? undefined
    : JdtlsWorkspace.inspect(root.workspacePath, {
      buildSystems: root.systems,
      excludedRoots: root.excludedRoots,
    }).requiredJavaMajor;
  const inventorySourcePaths = unique(sourceMappings.map((mapping) => mapping.sourceRoot));
  const effectiveSourcePaths = unique(inventorySourcePaths.length > 0
    ? inventorySourcePaths
    : sourcePaths.length > 0 ? sourcePaths : eclipse.sources.length > 0 ? eclipse.sources : discovered.sourcePaths);
  const representativeDocumentPath = representativeJavaDocument(effectiveSourcePaths);
  const model: JdtlsProjectModel = {
    buildRootId: root.id,
    projectName,
    buildRootPath: root.workspacePath,
    sourcePaths: effectiveSourcePaths,
    generatedSourcePaths: sourceInventory
      ? []
      : unique([...generatedSourcePaths, ...discovered.generatedSourcePaths]),
    sourceMappings,
    sourceLayout,
    ...(inventoryHash ? { sourceInventoryHash: inventoryHash } : {}),
    consolidatedSourceRoots: sourcePreparation.cacheRoot ? effectiveSourcePaths : [],
    uriAliases: [],
    compileClasspath: unique(compileClasspath),
    runtimeClasspath: unique(runtimeClasspath),
    languageServerClasspath: unique(languageServerClasspath),
    ...((typeof bazel?.javaMajor === 'number' ? bazel.javaMajor : inspectedJavaMajor) !== undefined
      ? { javaMajor: typeof bazel?.javaMajor === 'number' ? bazel.javaMajor : inspectedJavaMajor }
      : {}),
    buildSystems: root.systems,
    ...(typeof bazel?.configurationHash === 'string' ? { configurationHash: bazel.configurationHash } : {}),
    modelSource: bazelClasspath.length > 0
      ? 'bazel-java-info'
      : eclipse.libraries.length > 0 || eclipse.sources.length > 0
        ? 'eclipse-classpath'
        : 'source-discovery',
    projectImportMode: usesNativeJdtImport(root) ? 'native-build-tool' : 'external-eclipse',
    ...(representativeDocumentPath ? { representativeDocumentPath } : {}),
  };
  if (sourcePreparation.cacheLeasePath) cacheLeaseByModel.set(model, sourcePreparation.cacheLeasePath);
  progress?.({ phase: 'model-finalization', completed: 1, total: 1 });
  return model;
}

function sourceMapping(
  source: BazelCrawlSource,
  workspacePath: string,
  configurationHash: string,
): JdtlsSourceMapping {
  let analysisPath = path.resolve(source.analysisPath);
  const sourceJarEntry = source.sourceJarAssociations[0]?.sourceJarEntry;
  if (sourceJarEntry) {
    const components = sourceJarEntry.split('/').filter(Boolean);
    let sourceRoot = analysisPath;
    for (let index = 0; index < components.length; index += 1) sourceRoot = path.dirname(sourceRoot);
    return { sourcePath: path.resolve(source.path), analysisPath, sourceRoot };
  }
  const layout = packageSourceLayout(analysisPath);
  if (!layout.matchesPhysicalPath && layout.packageName) {
    const sourceRoot = path.join(
      workspacePath, '.gitnexus', 'jdtls', 'bazel-sources', configurationHash,
      'package-corrected', source.contentHash.slice(0, 24),
    );
    const destination = path.join(sourceRoot, ...layout.packageName.split('.'), path.basename(analysisPath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(fs.readFileSync(analysisPath))) {
      copyFileEfficiently(analysisPath, destination);
    }
    analysisPath = destination;
    return { sourcePath: path.resolve(source.path), analysisPath, sourceRoot };
  }
  return { sourcePath: path.resolve(source.path), analysisPath, sourceRoot: layout.sourceRoot };
}

/**
 * Large Bazel workspaces commonly expose one src/main/java directory per
 * target. Thousands of Eclipse classpath source entries make JDT import and
 * resource reconciliation disproportionately expensive. Stage package-correct
 * documents into a bounded set of roots while retaining URI mappings back to
 * the authoritative inventory path.
 */
function sourceMappingsForInventory(
  sources: BazelCrawlSource[],
  workspacePath: string,
  configurationHash: string,
  inventoryHash: string,
  cacheLeaseId: string,
  progress?: (event: JdtlsShardPreparationProgress) => void,
): InventorySourcePreparation {
  const mappings: JdtlsSourceMapping[] = [];
  progress?.({ phase: 'mapping-sources', completed: 0, total: sources.length });
  if (sources.length > CONSOLIDATION_THRESHOLD) {
    const entries = planConsolidatedCacheEntries(sources);
    progress?.({ phase: 'mapping-sources', completed: sources.length, total: sources.length });
    const cacheParent = path.join(workspacePath, '.gitnexus', 'jdtls', 'consolidated-sources');
    const cacheRoot = ensureConsolidatedSourceCache(cacheParent, inventoryHash, entries, progress);
    const cacheLeasePath = createCacheLease(cacheRoot, cacheLeaseId);
    progress?.({ phase: 'cache-pruning', completed: 0, total: 1 });
    pruneConsolidatedSourceCaches(cacheParent, cacheRoot);
    progress?.({ phase: 'cache-pruning', completed: 1, total: 1 });
    return {
      mappings: entries.map((entry) => ({
        sourcePath: entry.sourcePath,
        analysisPath: path.join(cacheRoot, entry.relativePath),
        sourceRoot: path.join(cacheRoot, entry.sourceRootRelative),
      })),
      cacheRoot,
      cacheLeasePath,
    };
  }
  for (let index = 0; index < sources.length; index += 1) {
    mappings.push(sourceMapping(sources[index], workspacePath, configurationHash));
    reportPreparationProgress(progress, 'mapping-sources', index + 1, sources.length);
  }
  return { mappings };
}

function planConsolidatedCacheEntries(sources: BazelCrawlSource[]): ConsolidatedCacheEntry[] {
  const occupied = new Set<string>();
  return sources.map((source) => {
    const inputPath = path.resolve(source.analysisPath);
    const sourceJarEntry = source.sourceJarAssociations[0]?.sourceJarEntry;
    let safeRelative: string;
    if (sourceJarEntry) {
      safeRelative = validatedCacheRelativePath(sourceJarEntry.split('/').filter(Boolean).join(path.sep));
    } else {
      const layout = packageSourceLayout(inputPath);
      const layoutRelative = layout.packageName
        ? path.join(...layout.packageName.split('.'), path.basename(inputPath))
        : path.basename(inputPath);
      safeRelative = validatedCacheRelativePath(layout.matchesPhysicalPath
        ? path.relative(layout.sourceRoot, inputPath)
        : layoutRelative);
    }
    const seed = Number.parseInt(
      createHash('sha256').update(path.resolve(source.path)).digest('hex').slice(0, 8), 16,
    );
    let attempt = 0;
    let bucket = seed % CONSOLIDATED_SOURCE_BUCKETS;
    let sourceRootRelative = `source-${bucket.toString().padStart(2, '0')}`;
    let relativePath = path.join(sourceRootRelative, safeRelative);
    while (occupied.has(cachePathKey(relativePath))) {
      attempt += 1;
      bucket = (seed + attempt) % CONSOLIDATED_SOURCE_BUCKETS;
      const bank = Math.floor(attempt / CONSOLIDATED_SOURCE_BUCKETS);
      sourceRootRelative = `source-${bucket.toString().padStart(2, '0')}${bank === 0 ? '' : `-${bank}`}`;
      relativePath = path.join(sourceRootRelative, safeRelative);
    }
    occupied.add(cachePathKey(relativePath));
    return {
      sourcePath: path.resolve(source.path),
      inputPath,
      contentHash: source.contentHash,
      relativePath,
      sourceRootRelative,
    };
  });
}

function ensureConsolidatedSourceCache(
  cacheParent: string,
  inventoryHash: string,
  entries: ConsolidatedCacheEntry[],
  progress?: (event: JdtlsShardPreparationProgress) => void,
): string {
  fs.mkdirSync(cacheParent, { recursive: true });
  const canonical = path.join(cacheParent, inventoryHash);
  progress?.({ phase: 'cache-validation', completed: 0, total: entries.length });
  if (validateConsolidatedSourceCache(canonical, inventoryHash, entries, progress)) {
    progress?.({ phase: 'cache-hit', completed: entries.length, total: entries.length });
    return canonical;
  }

  let destination = canonical;
  if (fs.existsSync(canonical)) {
    if (hasActiveCacheLeases(canonical)) {
      destination = path.join(cacheParent, `${inventoryHash}.rebuild-${randomUUID()}`);
    } else {
      const rejected = path.join(cacheParent, `.${inventoryHash}.invalid-${randomUUID()}`);
      fs.renameSync(canonical, rejected);
      fs.rmSync(rejected, { recursive: true, force: true });
    }
  }
  const temporary = path.join(cacheParent, `.${inventoryHash}.tmp-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(temporary, { recursive: true });
  progress?.({ phase: 'cache-build', completed: 0, total: entries.length });
  progress?.({ phase: 'consolidating-sources', completed: 0, total: entries.length });
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const outputPath = path.join(temporary, entry.relativePath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      copyFileEfficiently(entry.inputPath, outputPath);
      if (hashFile(outputPath) !== entry.contentHash) {
        throw new Error(`Consolidated source content does not match its inventory hash: ${entry.sourcePath}`);
      }
      reportPreparationProgress(progress, 'cache-build', index + 1, entries.length);
      reportPreparationProgress(progress, 'consolidating-sources', index + 1, entries.length);
    }
    progress?.({ phase: 'cache-finalization', completed: 0, total: 1 });
    const manifest: ConsolidatedCacheManifest = {
      schemaVersion: 1,
      sourceInventoryHash: inventoryHash,
      createdAt: new Date().toISOString(),
      entries: entries.map(({ inputPath: _inputPath, ...entry }) => entry),
    };
    writeJsonAtomically(path.join(temporary, CACHE_MANIFEST), manifest);
    if (fs.existsSync(destination)) {
      if (validateConsolidatedSourceCache(destination, inventoryHash, entries)) {
        fs.rmSync(temporary, { recursive: true, force: true });
        progress?.({ phase: 'cache-finalization', completed: 1, total: 1 });
        return destination;
      }
      destination = path.join(cacheParent, `${inventoryHash}.rebuild-${randomUUID()}`);
    }
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')
        || !validateConsolidatedSourceCache(destination, inventoryHash, entries)) throw error;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    progress?.({ phase: 'cache-finalization', completed: 1, total: 1 });
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function validateConsolidatedSourceCache(
  cacheRoot: string,
  inventoryHash: string,
  entries: ConsolidatedCacheEntry[],
  progress?: (event: JdtlsShardPreparationProgress) => void,
): boolean {
  const manifest = readJson(path.join(cacheRoot, CACHE_MANIFEST)) as Partial<ConsolidatedCacheManifest> | undefined;
  if (manifest?.schemaVersion !== 1
    || manifest.sourceInventoryHash !== inventoryHash
    || !Array.isArray(manifest.entries)
    || manifest.entries.length !== entries.length) return false;
  for (let index = 0; index < entries.length; index += 1) {
    const expected = entries[index];
    const actual = manifest.entries[index];
    if (!actual
      || actual.sourcePath !== expected.sourcePath
      || actual.contentHash !== expected.contentHash
      || actual.relativePath !== expected.relativePath
      || actual.sourceRootRelative !== expected.sourceRootRelative) return false;
    const cachedPath = path.join(cacheRoot, actual.relativePath);
    if (!fs.existsSync(cachedPath) || hashFile(cachedPath) !== actual.contentHash) return false;
    reportPreparationProgress(progress, 'cache-validation', index + 1, entries.length);
  }
  return true;
}

function packageSourceLayout(javaFile: string): {
  sourceRoot: string;
  packageName?: string;
  matchesPhysicalPath: boolean;
} {
  const conventional = javaFile.split(path.sep).join('/').match(/^(.*?src\/(?:main|test)\/java)(?:\/|$)/)?.[1];
  if (conventional) return { sourceRoot: path.resolve(conventional), matchesPhysicalPath: true };
  let packageName: string | undefined;
  try {
    packageName = fs.readFileSync(javaFile, 'utf8').match(/(?:^|\n)\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
  } catch { /* fall through */ }
  if (!packageName) return { sourceRoot: path.dirname(javaFile), matchesPhysicalPath: true };
  const packageParts = packageName.split('.');
  const directoryParts = path.dirname(javaFile).split(path.sep);
  const suffix = directoryParts.slice(-packageParts.length);
  const matchesPhysicalPath = suffix.join('\0') === packageParts.join('\0');
  return {
    sourceRoot: matchesPhysicalPath
      ? directoryParts.slice(0, -packageParts.length).join(path.sep) || path.parse(javaFile).root
      : path.dirname(javaFile),
    packageName,
    matchesPhysicalPath,
  };
}

function representativeJavaDocument(sourcePaths: string[]): string | undefined {
  for (const sourcePath of sourcePaths) {
    const relative = globSync('**/*.java', { cwd: sourcePath, nodir: true }).sort()[0];
    if (relative) return path.resolve(sourcePath, relative);
  }
  return undefined;
}

function readEclipseClasspath(workspacePath: string): { sources: string[]; libraries: string[] } {
  const classpathPath = path.join(workspacePath, '.classpath');
  if (!fs.existsSync(classpathPath)) return { sources: [], libraries: [] };
  const xmlText = fs.readFileSync(classpathPath, 'utf8');
  const sources: string[] = [];
  const libraries: string[] = [];
  for (const match of xmlText.matchAll(/<classpathentry\b([^>]*?)\/?\s*>/g)) {
    const attributes = match[1];
    const kind = attributes.match(/\bkind=["']([^"']+)["']/)?.[1];
    const entry = attributes.match(/\bpath=["']([^"']+)["']/)?.[1];
    if (!entry) continue;
    const absolute = path.isAbsolute(entry) ? entry : path.resolve(workspacePath, entry);
    if (kind === 'src' && fs.existsSync(absolute)) sources.push(absolute);
    if (kind === 'lib' && fs.existsSync(absolute)) libraries.push(absolute);
  }
  return { sources: unique(sources), libraries: unique(libraries) };
}

function discoverSourcePaths(workspacePath: string): { sourcePaths: string[]; generatedSourcePaths: string[] } {
  const files = globSync('**/*.java', {
    cwd: workspacePath, nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**', '**/bazel-*/**'],
  });
  const sources = new Set<string>();
  for (const file of files) {
    const normalized = file.split(path.sep).join('/');
    const conventional = normalized.match(/^(.*?src\/(?:main|test)\/java)(?:\/|$)/)?.[1];
    sources.add(path.resolve(workspacePath, conventional ?? path.posix.dirname(normalized)));
  }
  const generated = globSync(['bazel-out/**/generated*/**/*.java', 'build/generated/**/*.java', 'target/generated-sources/**/*.java'], {
    cwd: workspacePath, nodir: true, ignore: ['**/.git/**'],
  }).map((file) => path.resolve(workspacePath, generatedSourceRoot(file)));
  return { sourcePaths: [...sources].sort(), generatedSourcePaths: unique(generated) };
}

function generatedSourceRoot(file: string): string {
  const normalized = file.split(path.sep).join('/');
  for (const marker of ['/generated-sources/', '/generated/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(0, index + marker.length - 1);
  }
  return path.posix.dirname(normalized);
}

function writeEclipseProject(
  workspacePath: string,
  model: JdtlsProjectModel,
  progress?: (event: JdtlsShardPreparationProgress) => void,
): void {
  const projectPath = path.join(workspacePath, 'projects', model.projectName);
  model.eclipseProjectPath = projectPath;
  fs.mkdirSync(projectPath, { recursive: true });
  const allSources = unique([...model.sourcePaths, ...model.generatedSourcePaths]);
  const links = allSources.map((sourcePath, index) => ({
    name: `source-${index}`,
    authoritativePath: path.resolve(sourcePath),
    sourcePath: canonicalExistingPath(sourcePath),
    logicalPath: path.join(projectPath, `source-${index}`),
  }));
  if (model.sourceLayout === 'copied') {
    const sourceFilesByLink = links.map((link) => ({
      ...link, files: globSync('**/*.java', { cwd: link.sourcePath, nodir: true }),
    }));
    const totalSourceFiles = sourceFilesByLink.reduce((total, link) => total + link.files.length, 0);
    let completedSourceFiles = 0;
    progress?.({ phase: 'staging-sources', completed: 0, total: totalSourceFiles });
    for (const { sourcePath, logicalPath, files } of sourceFilesByLink) {
      fs.mkdirSync(logicalPath, { recursive: true });
      for (const relativeFile of files) {
        const sourceFile = path.resolve(sourcePath, relativeFile);
        const stagedFile = path.resolve(logicalPath, relativeFile);
        fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
        copyFileEfficiently(sourceFile, stagedFile);
        completedSourceFiles += 1;
        reportPreparationProgress(progress, 'staging-sources', completedSourceFiles, totalSourceFiles);
      }
    }
  } else {
    progress?.({ phase: 'link-project', completed: 0, total: links.length });
    for (let index = 0; index < links.length; index += 1) {
      reportPreparationProgress(progress, 'link-project', index + 1, links.length);
    }
  }
  const rootIndexes = new Map(allSources.map((sourcePath, index) => [path.resolve(sourcePath), index]));
  model.uriAliases = [
    ...links.map((link) => ({
      sourcePath: link.authoritativePath,
      physicalPath: model.sourceLayout === 'linked' ? link.sourcePath : link.logicalPath,
      logicalPath: link.logicalPath,
    })),
    ...model.sourceMappings.map((mapping) => {
      const rootIndex = rootIndexes.get(path.resolve(mapping.sourceRoot));
      const logicalPath = rootIndex === undefined
        ? mapping.analysisPath
        : path.join(
          projectPath,
          `source-${rootIndex}`,
          path.relative(mapping.sourceRoot, mapping.analysisPath),
        );
      return {
        sourcePath: mapping.sourcePath,
        physicalPath: model.sourceLayout === 'linked' ? mapping.analysisPath : logicalPath,
        logicalPath,
      };
    }),
  ];
  const linkedResources = model.sourceLayout === 'linked'
    ? [
      '  <linkedResources>',
      ...links.flatMap(({ name, sourcePath }) => [
        '    <link>', `      <name>${xml(name)}</name>`, '      <type>2</type>',
        `      <locationURI>${xml(pathToFileURL(sourcePath).href)}</locationURI>`, '    </link>',
      ]),
      '  </linkedResources>',
    ]
    : ['  <linkedResources></linkedResources>'];
  const projectXml = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<projectDescription>',
    `  <name>${xml(model.projectName)}</name>`, '  <comment></comment>', '  <projects></projects>',
    '  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec>',
    '  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>',
    ...linkedResources, '</projectDescription>', '',
  ].join('\n');
  const sourceEntries = links.map(({ name }) => `  <classpathentry kind="src" path="${xml(name)}"/>`);
  const libraries = model.languageServerClasspath.map((entry) => `  <classpathentry kind="lib" path="${xml(entry)}"/>`);
  const executionEnvironment = model.javaMajor ? `JavaSE-${model.javaMajor}` : 'JavaSE-21';
  const classpathXml = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<classpath>', ...sourceEntries,
    `  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/${executionEnvironment}"/>`,
    ...libraries, '  <classpathentry kind="output" path=".gitnexus-output"/>', '</classpath>', '',
  ].join('\n');
  fs.writeFileSync(path.join(projectPath, '.project'), projectXml);
  fs.writeFileSync(path.join(projectPath, '.classpath'), classpathXml);
  writeJsonAtomically(path.join(projectPath, '.gitnexus-project.json'), model);
}

function countJavaSources(root: JavaBuildRoot): number {
  return globSync('**/*.java', {
    cwd: root.workspacePath, nodir: true,
    ignore: ['**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**', '**/bazel-*/**'],
  }).length;
}

function readJson(filePath: string): unknown {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return undefined; }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'; }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function jdtlsSourceLayout(): JdtlsSourceLayout {
  const value = process.env.GITNEXUS_JDT_SOURCE_LAYOUT ?? 'linked';
  if (value !== 'linked' && value !== 'copied') {
    throw new Error(`GITNEXUS_JDT_SOURCE_LAYOUT must be linked or copied, got ${value}`);
  }
  return value;
}
function modelCacheLeasePaths(model: JdtlsProjectModel): string[] {
  const leasePath = cacheLeaseByModel.get(model);
  return leasePath ? [leasePath] : [];
}
function createCacheLease(cacheRoot: string, leaseId: string): string {
  const leases = path.join(cacheRoot, CACHE_LEASES);
  fs.mkdirSync(leases, { recursive: true });
  const leasePath = path.join(leases, `${safeName(leaseId)}-${randomUUID()}.json`);
  writeJsonAtomically(leasePath, { processId: process.pid, createdAt: new Date().toISOString() });
  return leasePath;
}
function hasActiveCacheLeases(cacheRoot: string): boolean {
  const leases = path.join(cacheRoot, CACHE_LEASES);
  if (!fs.existsSync(leases)) return false;
  let active = false;
  for (const name of fs.readdirSync(leases)) {
    const leasePath = path.join(leases, name);
    const lease = readJson(leasePath) as { processId?: unknown } | undefined;
    if (typeof lease?.processId === 'number' && processExists(lease.processId)) {
      active = true;
    } else {
      fs.rmSync(leasePath, { force: true });
    }
  }
  return active;
}
function processExists(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
function pruneConsolidatedSourceCaches(cacheParent: string, currentRoot: string): void {
  const completed = fs.readdirSync(cacheParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(cacheParent, entry.name))
    .filter((entryPath) => fs.existsSync(path.join(entryPath, CACHE_MANIFEST)))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const retained = new Set(completed.slice(0, 2).map((entryPath) => path.resolve(entryPath)));
  retained.add(path.resolve(currentRoot));
  for (const cacheRoot of completed) {
    if (retained.has(path.resolve(cacheRoot)) || hasActiveCacheLeases(cacheRoot)) continue;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}
function canonicalExistingPath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}
function cachePathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}
function validatedCacheRelativePath(value: string): string {
  const normalized = path.normalize(value);
  if (!normalized || path.isAbsolute(normalized) || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Invalid consolidated source relative path: ${value}`);
  }
  return normalized;
}
function hashFile(filename: string): string {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}
function copyFileEfficiently(source: string, destination: string): void {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}
function reportPreparationProgress(
  progress: ((event: JdtlsShardPreparationProgress) => void) | undefined,
  phase: JdtlsShardPreparationProgress['phase'],
  completed: number,
  total: number,
): void {
  if (completed === total || completed === 1 || completed % 250 === 0) {
    progress?.({ phase, completed, total });
  }
}
function writeJsonAtomically(destination: string, value: unknown): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}
