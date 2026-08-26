import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';
import { jdtlsResolutionClasspath, JdtlsWorkspace, type JavaBuildRoot } from './jdtls-runtime.js';
import { readBazelSourceInventory, type BazelCrawlSource } from './bazel-source-inventory.js';

export interface JdtlsSourceMapping {
  sourcePath: string;
  analysisPath: string;
  sourceRoot: string;
}

export interface JdtlsProjectModel {
  buildRootId: string;
  projectName: string;
  buildRootPath: string;
  sourcePaths: string[];
  generatedSourcePaths: string[];
  sourceMappings: JdtlsSourceMapping[];
  compileClasspath: string[];
  runtimeClasspath: string[];
  languageServerClasspath: string[];
  javaMajor?: number;
  buildSystems: string[];
  configurationHash?: string;
  modelSource: 'bazel-java-info' | 'eclipse-classpath' | 'source-discovery';
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
}

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

/** Materialize staged Eclipse projects consumed by one persistent JDT LS process. */
export function prepareJdtlsShardWorkspace(
  repositoryPath: string,
  shard: JdtlsBuildRootShard,
): PreparedJdtlsShard {
  const repositoryHash = createHash('sha256').update(path.resolve(repositoryPath)).digest('hex').slice(0, 16);
  // Eclipse persists project locations using canonical filesystem paths. On
  // macOS, /tmp is a symlink to /private/tmp; constructing client URIs from
  // the non-canonical spelling makes JDTUtils miss the imported IProject and
  // silently place the document in its classpath-less invisible project.
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const workspacePath = path.join(temporaryRoot, 'gitnexus-jdt-projects', repositoryHash, shard.id);
  fs.mkdirSync(workspacePath, { recursive: true });
  // Shard membership may change as roots are added or rebalanced. Generated
  // projects are disposable; remove stale members so they cannot leak into a
  // later JDT process using the same shard id.
  fs.rmSync(path.join(workspacePath, 'projects'), { recursive: true, force: true });
  const projectModels = shard.roots.map(loadProjectModel);
  for (const model of projectModels) writeEclipseProject(workspacePath, model);
  const manifest = {
    schemaVersion: 1,
    shardId: shard.id,
    generatedAt: new Date().toISOString(),
    projects: projectModels,
  };
  writeJsonAtomically(path.join(workspacePath, 'gitnexus-jdtls-shard.json'), manifest);
  return { ...shard, workspacePath, projectModels };
}

function loadProjectModel(root: JavaBuildRoot): JdtlsProjectModel {
  const bazelModelPath = path.resolve(
    root.workspacePath,
    process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL ?? '.gitnexus/jdtls/bazel-project.json',
  );
  const bazel = readJson(bazelModelPath) as {
    sourcePaths?: unknown; generatedSourcePaths?: unknown; classpath?: unknown; runtimeClasspath?: unknown;
    javaMajor?: unknown; configurationHash?: unknown; sourceInventoryPath?: unknown;
  } | undefined;
  const configuredInventoryPath = typeof bazel?.sourceInventoryPath === 'string'
    ? path.resolve(root.workspacePath, bazel.sourceInventoryPath)
    : path.join(root.workspacePath, '.gitnexus', 'jdtls', 'bazel-source-inventory.json');
  const sourceInventory = readBazelSourceInventory(configuredInventoryPath);
  const sourceMappings = sourceInventory?.sources.map((source) => sourceMapping(
    source,
    sourceInventory.workspacePath,
    sourceInventory.configurationHash,
  )) ?? [];
  const sourcePaths = stringArray(bazel?.sourcePaths).map((entry) => path.resolve(root.workspacePath, entry));
  const eclipse = readEclipseClasspath(root.workspacePath);
  const discovered = discoverSourcePaths(root.workspacePath);
  const generatedSourcePaths = stringArray(bazel?.generatedSourcePaths)
    .map((entry) => path.resolve(root.workspacePath, entry));
  const bazelClasspath = stringArray(bazel?.classpath)
    .map((entry) => path.resolve(root.workspacePath, entry)).filter(fs.existsSync);
  const runtimeClasspath = stringArray(bazel?.runtimeClasspath)
    .map((entry) => path.resolve(root.workspacePath, entry)).filter(fs.existsSync);
  const compileClasspath = bazelClasspath.length > 0 ? bazelClasspath : eclipse.libraries;
  const languageServerClasspath = bazelClasspath.length > 0
    ? jdtlsResolutionClasspath({ classpath: bazelClasspath, runtimeClasspath })
    : compileClasspath;
  // Never let a build-root id become the leading project-name token. JDT's
  // standard resource filters include `bazel-.*`; a project named after a
  // `bazel:` root is imported but all of its source resources are hidden.
  const projectName = `gitnexus-${safeName(root.id)}-${createHash('sha256').update(root.id).digest('hex').slice(0, 8)}`;
  const inspectedJavaMajor = JdtlsWorkspace.inspect(root.workspacePath, {
    buildSystems: root.systems,
    excludedRoots: root.excludedRoots,
  }).requiredJavaMajor;
  const inventorySourcePaths = unique(sourceMappings.map((mapping) => mapping.sourceRoot));
  const effectiveSourcePaths = unique(inventorySourcePaths.length > 0
    ? inventorySourcePaths
    : sourcePaths.length > 0 ? sourcePaths : eclipse.sources.length > 0 ? eclipse.sources : discovered.sourcePaths);
  return {
    buildRootId: root.id,
    projectName,
    buildRootPath: root.workspacePath,
    sourcePaths: effectiveSourcePaths,
    generatedSourcePaths: sourceInventory
      ? []
      : unique([...generatedSourcePaths, ...discovered.generatedSourcePaths]),
    sourceMappings,
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
    ...(representativeJavaDocument(effectiveSourcePaths) ? {
      representativeDocumentPath: representativeJavaDocument(effectiveSourcePaths),
    } : {}),
  };
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
      fs.copyFileSync(analysisPath, destination);
    }
    analysisPath = destination;
    return { sourcePath: path.resolve(source.path), analysisPath, sourceRoot };
  }
  return { sourcePath: path.resolve(source.path), analysisPath, sourceRoot: layout.sourceRoot };
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

function writeEclipseProject(workspacePath: string, model: JdtlsProjectModel): void {
  const projectPath = path.join(workspacePath, 'projects', model.projectName);
  fs.mkdirSync(projectPath, { recursive: true });
  const allSources = unique([...model.sourcePaths, ...model.generatedSourcePaths]);
  const links = allSources.map((sourcePath, index) => ({ name: `source-${index}`, sourcePath }));
  for (const { name, sourcePath } of links) {
    const stagedSourcePath = path.join(projectPath, name);
    fs.mkdirSync(stagedSourcePath, { recursive: true });
    for (const relativeFile of globSync('**/*.java', { cwd: sourcePath, nodir: true })) {
      const sourceFile = path.resolve(sourcePath, relativeFile);
      const stagedFile = path.resolve(stagedSourcePath, relativeFile);
      fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
      fs.copyFileSync(sourceFile, stagedFile);
    }
  }
  const projectXml = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<projectDescription>',
    `  <name>${xml(model.projectName)}</name>`, '  <comment></comment>', '  <projects></projects>',
    '  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec>',
    '  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>',
    '  <linkedResources></linkedResources>', '</projectDescription>', '',
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
function writeJsonAtomically(destination: string, value: unknown): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}
