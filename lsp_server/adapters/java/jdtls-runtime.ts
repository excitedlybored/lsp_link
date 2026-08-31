/**
 * JDT.LS runtime: JDK 21+ for the compiler process, Equinox launcher jars,
 * workspace size, and the JVM command line.
 *
 * The project's source level is unchanged — every `.java` file is still
 * indexed. The compiler itself simply cannot boot on JDK 17.
 */

import * as fs from 'fs';
import * as path from 'path';
import { locateSpringToolsRuntime, springToolsEnabled } from './spring-tools-runtime.js';
import * as os from 'os';
import { createHash } from 'crypto';
import { globSync } from 'glob';

const VENDORED_JDTLS_VERSION = '1.57.0';

export interface JdtlsRuntime {
  jdkJavaBin: string;
  jdkMajorVersion: number;
  equinoxLauncherJar: string;
  osgiConfigDir: string;
}

export interface JdtlsProcessLaunch {
  command: string;
  args: string[];
  initializationOptions: Record<string, unknown>;
}

export type JavaBuildSystemKind = 'gradle' | 'maven' | 'bazel';

export interface JavaBuildSystem {
  kind: JavaBuildSystemKind;
  roots: string[];
  importMode: 'native' | 'external-model';
}

export interface BazelProjectModel {
  modelPath: string;
  classpath: string[];
  runtimeClasspath?: string[];
  sourcePaths: string[];
  generatedSourcePaths?: string[];
  outputPath?: string;
  javaMajor?: number;
}

/**
 * JDT needs full class files for navigation. Bazel compile classpaths commonly
 * contain interface/header JARs, so replace each header with its matching
 * runtime binary while retaining compile-only entries that have no match.
 */
export function jdtlsResolutionClasspath(model: Pick<BazelProjectModel, 'classpath' | 'runtimeClasspath'>): string[] {
  const runtime = model.runtimeClasspath ?? [];
  const runtimeByDirectoryAndIdentity = new Map(runtime.map((jar) => [
    `${path.dirname(jar)}\0${jarIdentity(jar)}`, jar,
  ]));
  const runtimeByIdentity = new Map<string, string[]>();
  for (const jar of runtime) {
    const identity = jarIdentity(jar);
    const values = runtimeByIdentity.get(identity) ?? [];
    values.push(jar);
    runtimeByIdentity.set(identity, values);
  }
  return [...new Set(model.classpath.map((compileJar) => {
    const identity = jarIdentity(compileJar);
    return runtimeByDirectoryAndIdentity.get(`${path.dirname(compileJar)}\0${identity}`)
      ?? (runtimeByIdentity.get(identity)?.length === 1 ? runtimeByIdentity.get(identity)![0] : undefined)
      ?? compileJar;
  }))].sort();
}

function jarIdentity(jarPath: string): string {
  return path.basename(jarPath)
    .replace(/^header_/, '')
    .replace(/^processed_/, '')
    .replace(/-hjar(?=\.jar$)/, '')
    .replace(/\.ijar(?=\.jar$)/, '');
}

export interface JavaBuildImportStatus {
  kind: JavaBuildSystemKind;
  roots: string[];
  mode: JavaBuildSystem['importMode'];
  status: 'ready' | 'disabled' | 'missing-external-model';
}

export interface JavaBuildRoot {
  id: string;
  workspacePath: string;
  relativePath: string;
  systems: JavaBuildSystemKind[];
  excludedRoots: string[];
}

export interface JdtlsWorkspaceOptions {
  buildSystems?: JavaBuildSystemKind[];
  excludedRoots?: string[];
  eclipseProjectImport?: boolean;
  sourceFileCount?: number;
}

/** Native build-tool roots must not also be owned by a generated Eclipse project. */
export function usesNativeJdtImport(root: JavaBuildRoot): boolean {
  return enabledNativeJdtBuildSystems(root).length > 0;
}

export function enabledNativeJdtBuildSystems(root: JavaBuildRoot): JavaBuildSystemKind[] {
  // Copied layout is the explicit compatibility/recovery path: the generated
  // Eclipse project, rather than a native importer, must own its copied files.
  if (process.env.GITNEXUS_JDT_SOURCE_LAYOUT?.trim().toLowerCase() === 'copied') return [];
  if (root.systems.includes('bazel') || root.systems.length === 0) return [];
  const workspace = JdtlsWorkspace.inspect(root.workspacePath, {
    buildSystems: root.systems,
    excludedRoots: root.excludedRoots,
  });
  const enabled = root.systems.filter((kind): kind is 'gradle' | 'maven' =>
    kind !== 'bazel' && workspace.buildImportEnabled(kind));
  if (enabled.length <= 1) return enabled;

  // JDT must have exactly one native owner for a source tree. Running M2E and
  // Buildship over the same files creates competing Eclipse projects, unstable
  // launch configurations, and classpaths whose provenance cannot be trusted.
  const configuredValue = process.env.GITNEXUS_JDT_NATIVE_IMPORTER?.trim().toLowerCase();
  if (configuredValue && configuredValue !== 'gradle' && configuredValue !== 'maven') {
    throw new Error('GITNEXUS_JDT_NATIVE_IMPORTER must be either gradle or maven');
  }
  const configured: 'gradle' | 'maven' | undefined = configuredValue === 'gradle' || configuredValue === 'maven'
    ? configuredValue
    : undefined;
  const selected = configured && enabled.includes(configured)
    ? configured
    : preferredNativeImporter(root.workspacePath, enabled);
  return [enabled.includes(selected) ? selected : enabled[0]!];
}

// JDT.LS 1.57.0 bundles org.gradle.toolingapi 8.9. A newer wrapper may start
// but never publish an Eclipse project, so a dual-build root must use M2E
// instead of waiting on a Buildship model that cannot become ready.
const BUNDLED_GRADLE_TOOLING_API_MAJOR = 8;

function preferredNativeImporter(
  workspacePath: string,
  enabled: Array<'gradle' | 'maven'>,
): 'gradle' | 'maven' {
  if (enabled.includes('maven')) {
    const wrapper = path.join(workspacePath, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    try {
      const match = fs.readFileSync(wrapper, 'utf8').match(/distributionUrl=.*gradle-(\d+)(?:\.\d+)*-(?:bin|all)\.zip/i);
      const wrapperMajor = match ? Number(match[1]) : undefined;
      if (wrapperMajor !== undefined && wrapperMajor > BUNDLED_GRADLE_TOOLING_API_MAJOR) return 'maven';
    } catch { /* no readable Gradle wrapper; preserve the default below */ }
  }
  return 'gradle';
}

const JAVA_IGNORE = ['**/node_modules/**', '**/build/**', '**/target/**', '**/.git/**'];

export class JdtlsRuntimeLocator {
  static isInstalled(): boolean {
    try {
      JdtlsRuntimeLocator.locate();
      return true;
    } catch {
      return false;
    }
  }

  static locate(preferredMajor?: number): JdtlsRuntime {
    const { equinoxLauncherJar, osgiConfigDir } = JdtlsRuntimeLocator.findEquinoxInstall();
    const selected = JdtlsRuntimeLocator.selectCompilerJdk(preferredMajor);
    return {
      jdkJavaBin: selected.bin,
      jdkMajorVersion: selected.version,
      equinoxLauncherJar,
      osgiConfigDir,
    };
  }

  /** JDT.LS (redhat.java 1.40+) needs JDK 21+. Never boot the compiler on 17. */
  private static selectCompilerJdk(preferredMajor?: number): { bin: string; version: number } {
    const candidates = jdtlsJavaCandidates();

    const overrideHome = process.env.GITNEXUS_JDT_JAVA_HOME;
    if (overrideHome) {
      const selected = javaCandidate(path.join(overrideHome, 'bin', 'java'));
      if (!selected) {
        throw new Error(`GITNEXUS_JDT_JAVA_HOME does not point to a readable Java runtime: ${overrideHome}`);
      }
      if (selected.version < 21) {
        throw new Error(`GITNEXUS_JDT_JAVA_HOME selects Java ${selected.version}; JDT.LS requires Java 21+.`);
      }
      return selected;
    }

    if (process.env.JAVA_HOME) candidates.unshift(path.join(process.env.JAVA_HOME, 'bin', 'java'));

    const unique = [...new Set(candidates.filter((p) => fs.existsSync(p)))];
    const scored = unique.map(javaCandidate).filter((candidate): candidate is { bin: string; version: number } => Boolean(candidate));
    const jdk21OrNewer = scored.filter((s) => s.version >= 21).sort((a, b) => {
      if (a.version !== b.version) return a.version === 21 ? -1 : b.version === 21 ? 1 : b.version - a.version;
      return 0;
    });
    const preferred = preferredMajor
      ? jdk21OrNewer.find((candidate) => candidate.version === preferredMajor)
      : undefined;
    if (preferred) return preferred;
    if (jdk21OrNewer.length > 0) return jdk21OrNewer[0];

    throw new Error(
      'JDT.LS requires JDK 21+. Install a JDK 21+ runtime or set GITNEXUS_JDT_JAVA_HOME or JAVA_HOME. JDK 17 cannot run redhat.java 1.55.'
    );
  }

  private static findEquinoxInstall(): { equinoxLauncherJar: string; osgiConfigDir: string } {
    for (const workspaceRoot of ancestorDirectories(process.cwd())) {
      const bundled = runtimeInstall(path.join(workspaceRoot, 'vendor', 'jdtls', VENDORED_JDTLS_VERSION));
      if (bundled) return bundled;
    }

    const serverDirs = [
      ...globSync(path.join(os.homedir(), '.vscode/extensions/redhat.java-*/server')),
      ...globSync(path.join(os.homedir(), '.cursor/extensions/redhat.java-*/server')),
    ];

    for (const serverDir of serverDirs) {
      const installed = runtimeInstall(serverDir);
      if (installed) return installed;
    }

    throw new Error(
      `Eclipse JDT.LS launcher not found. Expected vendor/jdtls/${VENDORED_JDTLS_VERSION} or a Red Hat Java extension in ~/.vscode/extensions or ~/.cursor/extensions.`
    );
  }
}

/** Candidate JVMs shared in scope with the broader ASM-worker discovery paths. */
export function jdtlsJavaCandidates(homeDirectory = os.homedir()): string[] {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  if (process.platform === 'win32') {
    return globSync(path.join(homeDirectory, `.jdks/*/bin/${executable}`));
  }
  return [
    ...globSync('/usr/lib/jvm/*/bin/java'),
    ...globSync('/opt/java/openjdk/bin/java'),
    ...globSync('/opt/homebrew/opt/openjdk@21/bin/java'),
    ...globSync('/opt/homebrew/opt/openjdk@2*/bin/java'),
    ...globSync('/opt/homebrew/opt/openjdk/bin/java'),
    ...globSync('/opt/homebrew/Cellar/openjdk@21/*/libexec/openjdk.jdk/Contents/Home/bin/java'),
    ...globSync('/opt/homebrew/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home/bin/java'),
    ...globSync('/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java'),
    ...globSync(path.join(homeDirectory, '.local/jdks/*/bin/java')),
    ...globSync(path.join(homeDirectory, 'Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java')),
  ];
}

function runtimeInstall(serverDir: string): { equinoxLauncherJar: string; osgiConfigDir: string } | undefined {
  const launcherJars = globSync(path.join(serverDir, 'plugins/org.eclipse.equinox.launcher_*.jar'));
  const osgiConfigDir = jdtlsConfigDirectories(serverDir).find((dir) => fs.existsSync(dir));
  return launcherJars.length > 0 && osgiConfigDir
    ? { equinoxLauncherJar: launcherJars.sort()[0], osgiConfigDir }
    : undefined;
}

function jdtlsConfigDirectories(serverDir: string): string[] {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? [path.join(serverDir, 'config_mac_arm'), path.join(serverDir, 'config_mac')]
      : [path.join(serverDir, 'config_mac')];
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64'
      ? [path.join(serverDir, 'config_linux_arm'), path.join(serverDir, 'config_linux')]
      : [path.join(serverDir, 'config_linux')];
  }
  if (process.platform === 'win32') return [path.join(serverDir, 'config_win')];
  return [];
}

function ancestorDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(start);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

/** Project shape used to size heap, initialize wait, and Maven/Gradle import. */
export class JdtlsWorkspace {
  readonly sourceFileCount: number;
  readonly buildSystems: JavaBuildSystem[];
  readonly requiredJavaMajor?: number;
  readonly usesGradleIsolatedProjects: boolean;
  readonly bazelProjectModel?: BazelProjectModel;
  readonly importExclusions: string[];
  readonly eclipseProjectImport: boolean;

  private constructor(
    sourceFileCount: number,
    buildSystems: JavaBuildSystem[],
    requiredJavaMajor?: number,
    usesGradleIsolatedProjects = false,
    bazelProjectModel?: BazelProjectModel,
    importExclusions: string[] = [],
    eclipseProjectImport = false,
  ) {
    this.sourceFileCount = sourceFileCount;
    this.buildSystems = buildSystems;
    this.requiredJavaMajor = requiredJavaMajor;
    this.usesGradleIsolatedProjects = usesGradleIsolatedProjects;
    this.bazelProjectModel = bazelProjectModel;
    this.importExclusions = importExclusions;
    this.eclipseProjectImport = eclipseProjectImport;
  }

  get usesMaven(): boolean { return this.hasBuildSystem('maven'); }
  get usesGradle(): boolean { return this.hasBuildSystem('gradle'); }
  get usesBazel(): boolean { return this.hasBuildSystem('bazel'); }

  static inspect(workspacePath: string, options: JdtlsWorkspaceOptions = {}): JdtlsWorkspace {
    const enabledKinds = options.buildSystems ? new Set(options.buildSystems) : undefined;
    const buildIgnore = buildScanIgnore(workspacePath, options.excludedRoots ?? []);
    const sourceFileCount = options.sourceFileCount ?? globSync('**/*.java', {
        cwd: workspacePath,
        nodir: true,
        ignore: buildIgnore,
      }).length;

    const gradleProperties = readGradleProperties(workspacePath);
    const buildSystems = options.buildSystems
      ? options.buildSystems.map((kind): JavaBuildSystem => ({
          kind,
          roots: [path.resolve(workspacePath)],
          importMode: kind === 'bazel' ? 'external-model' : 'native',
        }))
      : detectJavaBuildSystems(workspacePath);
    const bazelProjectModel = !enabledKinds || enabledKinds.has('bazel')
      ? readBazelProjectModel(workspacePath)
      : undefined;
    const declaredMajors = [
      !enabledKinds || enabledKinds.has('gradle') ? declaredGradleJavaMajor(workspacePath, gradleProperties, buildIgnore) : undefined,
      !enabledKinds || enabledKinds.has('maven') ? declaredMavenJavaMajor(workspacePath, buildIgnore) : undefined,
      !enabledKinds || enabledKinds.has('bazel') ? declaredBazelJavaMajor(workspacePath) : undefined,
      (!enabledKinds || enabledKinds.has('bazel')) ? bazelProjectModel?.javaMajor : undefined,
    ].filter((major): major is number => major !== undefined);
    return new JdtlsWorkspace(
      sourceFileCount,
      buildSystems,
      declaredMajors.length > 0 ? Math.max(...declaredMajors) : undefined,
      gradlePropertyEnabled(gradleProperties, 'org.gradle.unsafe.isolated-projects'),
      bazelProjectModel,
      (options.excludedRoots ?? []).map((root) => {
        const relative = path.relative(workspacePath, root).split(path.sep).join('/');
        return relative ? `${relative}/**` : '';
      }).filter(Boolean),
      options.eclipseProjectImport ?? false,
    );
  }

  hasBuildSystem(kind: JavaBuildSystemKind): boolean {
    return this.buildSystems.some((system) => system.kind === kind);
  }

  buildImportEnabled(kind: JavaBuildSystemKind): boolean {
    const providerOverride = envBoolean(`GITNEXUS_JDT_${kind.toUpperCase()}_IMPORT`);
    if (providerOverride !== undefined) return providerOverride;
    const globalOverride = envBoolean('GITNEXUS_JDT_IMPORT');
    if (globalOverride !== undefined) return globalOverride;
    return this.hasBuildSystem(kind);
  }

  buildImportStatuses(): JavaBuildImportStatus[] {
    return this.buildSystems.map((system) => {
      const enabled = this.buildImportEnabled(system.kind);
      const status: JavaBuildImportStatus['status'] = !enabled
        ? 'disabled'
        : system.kind === 'bazel' && !this.bazelProjectModel
          ? 'missing-external-model'
          : 'ready';
      return { kind: system.kind, roots: system.roots, mode: system.importMode, status };
    });
  }

  heapXmx(): string {
    return jdtlsHeapXmx(this.sourceFileCount);
  }

  initializeTimeoutMs(): number {
    return Math.min(180_000, Math.max(60_000, this.sourceFileCount * 20));
  }

  serviceReadyTimeoutMs(): number {
    return Math.min(180_000, Math.max(30_000, this.sourceFileCount * 20));
  }

  importQuietTimeoutMs(): number {
    if (this.importBuildTools()) {
      return Math.min(180_000, Math.max(60_000, this.sourceFileCount * 100));
    }
    return Math.min(180_000, Math.max(8_000, this.sourceFileCount * 20));
  }

  /** Import build-tool models by default so semantic LSP results have a classpath. */
  importBuildTools(): boolean {
    return this.eclipseProjectImport || this.buildImportStatuses().some((provider) => provider.status === 'ready');
  }

  /** Buildship's import init scripts are not compatible with Gradle isolated projects. */
  gradleImportArguments(): string | undefined {
    const argumentsList = process.env.GITNEXUS_JDT_GRADLE_ARGUMENTS?.trim()
      ? [process.env.GITNEXUS_JDT_GRADLE_ARGUMENTS.trim()]
      : [];
    if (this.usesGradleIsolatedProjects) {
      argumentsList.push('--no-configuration-cache', '-Dorg.gradle.unsafe.isolated-projects=false');
    }
    return argumentsList.length > 0 ? argumentsList.join(' ') : undefined;
  }
}

export function jdtlsHeapGigabytes(sourceFileCount: number): number {
  if (sourceFileCount > 5000) return 6;
  if (sourceFileCount > 2000) return 4;
  return 2;
}

export function jdtlsHeapXmx(sourceFileCount: number): string {
  return `${jdtlsHeapGigabytes(sourceFileCount)}G`;
}

export function jdtlsVmArguments(opts: {
  runtime: JdtlsRuntime;
  dataDir: string;
  heapXmx: string;
}): string[] {
  const { runtime, dataDir, heapXmx } = opts;
  return [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dlog.level=WARNING',
    '-XX:TieredStopAtLevel=1',
    '-Xms512M',
    `-Xmx${heapXmx}`,
    '-XX:+UseG1GC',
    '-XX:+UseStringDeduplication',
    '--add-modules=ALL-SYSTEM',
    '--add-opens',
    'java.base/java.util=ALL-UNNAMED',
    '--add-opens',
    'java.base/java.lang=ALL-UNNAMED',
    '-jar',
    runtime.equinoxLauncherJar,
    '-configuration',
    runtime.osgiConfigDir,
    '-data',
    dataDir,
  ];
}

export function createJdtlsProcessLaunch(
  workspacePath: string,
  workspace: JdtlsWorkspace,
  runtime: JdtlsRuntime,
  dataDir?: string
): JdtlsProcessLaunch {
  const resolvedDataDir = dataDir ?? defaultWorkspaceDataDir(workspacePath);
  fs.rmSync(resolvedDataDir, { recursive: true, force: true });
  fs.mkdirSync(resolvedDataDir, { recursive: true });

  const springTools = springToolsEnabled() ? locateSpringToolsRuntime() : null;
  return {
    command: runtime.jdkJavaBin,
    args: jdtlsVmArguments({
      runtime,
      dataDir: resolvedDataDir,
      heapXmx: workspace.heapXmx(),
    }),
    initializationOptions: {
      ...(springTools?.jdtBundles.length ? { bundles: springTools.jdtBundles } : {}),
      extendedClientCapabilities: {
        skipProjectConfiguration: !workspace.importBuildTools(),
        classFileContentsSupport: true,
        shouldLanguageServerExitOnShutdown: true,
      },
      settings: {
        java: {
          autobuild: { enabled: workspace.importBuildTools() },
          maxConcurrentBuilds: 1,
          errors: { incompleteClasspath: { severity: 'ignore' } },
          configuration: {
            updateBuildConfiguration: workspace.importBuildTools() ? 'automatic' : 'disabled',
            maven: {
              ...(process.env.GITNEXUS_JDT_MAVEN_USER_SETTINGS ? { userSettings: path.resolve(workspacePath, process.env.GITNEXUS_JDT_MAVEN_USER_SETTINGS) } : {}),
              ...(process.env.GITNEXUS_JDT_MAVEN_GLOBAL_SETTINGS ? { globalSettings: path.resolve(workspacePath, process.env.GITNEXUS_JDT_MAVEN_GLOBAL_SETTINGS) } : {}),
            },
          },
          project: {
            importOnFirstTimeStartup: workspace.importBuildTools() ? 'automatic' : 'disabled',
            resourceFilters: ['node_modules', '.git', 'build', 'target', '.gradle', 'bazel-.*'],
            ...(workspace.bazelProjectModel ? {
              referencedLibraries: { include: jdtlsResolutionClasspath(workspace.bazelProjectModel) },
              sourcePaths: [
                ...workspace.bazelProjectModel.sourcePaths,
                ...(workspace.bazelProjectModel.generatedSourcePaths ?? []),
              ],
              ...(workspace.bazelProjectModel.outputPath ? { outputPath: workspace.bazelProjectModel.outputPath } : {}),
            } : {}),
          },
          import: {
            gradle: {
              enabled: workspace.usesGradle && workspace.buildImportEnabled('gradle'),
              java: { home: path.dirname(path.dirname(runtime.jdkJavaBin)) },
              offline: { enabled: envBoolean('GITNEXUS_JDT_GRADLE_OFFLINE') ?? false },
              ...(process.env.GITNEXUS_JDT_GRADLE_USER_HOME ? { user: { home: path.resolve(workspacePath, process.env.GITNEXUS_JDT_GRADLE_USER_HOME) } } : {}),
              ...(workspace.gradleImportArguments() ? { arguments: workspace.gradleImportArguments() } : {}),
            },
            maven: {
              enabled: workspace.usesMaven && workspace.buildImportEnabled('maven'),
              offline: { enabled: envBoolean('GITNEXUS_JDT_MAVEN_OFFLINE') ?? false },
            },
            exclusions: [
              '**/node_modules/**',
              '**/.git/**',
              '**/build/**',
              '**/target/**',
              '**/.gradle/**',
              ...workspace.importExclusions,
            ],
          },
        },
      },
    },
  };
}

function defaultWorkspaceDataDir(workspacePath: string): string {
  const hash = createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 16);
  return path.join('/tmp', `gitnexus_jdtls_${hash}`);
}

function jdkMajorVersionFromPath(javaBin: string): number {
  const patterns = [
    /openjdk@(\d+)/,
    /openjdk-(\d+)/,
    /\/jdk-(\d+)/,
    /ms-(\d+)/,
    /corretto-(\d+)/,
    /zulu-(\d+)/,
    /temurin-(\d+)/,
    /\/(\d+)\.[\d.]+[^/]*\/Contents\/Home/,
  ];
  for (const re of patterns) {
    const match = javaBin.match(re);
    if (match) return parseInt(match[1], 10);
  }
  return 0;
}

function javaCandidate(javaBin: string): { bin: string; version: number } | null {
  if (!fs.existsSync(javaBin)) return null;
  let resolved = javaBin;
  try {
    resolved = fs.realpathSync(javaBin);
  } catch {
    // The original path may still carry a parseable distribution/version name.
  }
  return { bin: javaBin, version: jdkMajorVersionFromPath(`${javaBin}:${resolved}`) };
}

function readGradleProperties(workspacePath: string): string {
  const propertiesPath = path.join(workspacePath, 'gradle.properties');
  return fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, 'utf8') : '';
}

function declaredJavaMajor(properties: string): number | undefined {
  for (const key of ['sourceCompatibility', 'targetCompatibility']) {
    const match = properties.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm'));
    if (match) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

function declaredGradleJavaMajor(workspacePath: string, properties: string, ignore: string[] = JAVA_IGNORE): number | undefined {
  const majors: number[] = [];
  const propertiesMajor = declaredJavaMajor(properties);
  if (propertiesMajor !== undefined) majors.push(propertiesMajor);
  const patterns = [
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g,
    /JavaVersion\.VERSION_(\d+)/g,
    /(?:sourceCompatibility|targetCompatibility)\s*=\s*["']?(?:1\.)?(\d+)/g,
  ];
  for (const buildFile of globSync('**/build.gradle{,.kts}', { cwd: workspacePath, nodir: true, ignore })) {
    const content = fs.readFileSync(path.join(workspacePath, buildFile), 'utf8');
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) majors.push(Number.parseInt(match[1], 10));
    }
  }
  return majors.length > 0 ? Math.max(...majors) : undefined;
}

function gradlePropertyEnabled(properties: string, key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escapedKey}\\s*=\\s*true\\s*$`, 'im').test(properties);
}

function detectJavaBuildSystems(workspacePath: string): JavaBuildSystem[] {
  const systems: JavaBuildSystem[] = [];
  const markerRoots = (markers: string[]): string[] => minimalBuildRoots(
    markers.flatMap((marker) => globSync(marker, { cwd: workspacePath, nodir: true, ignore: JAVA_IGNORE }))
      .map((marker) => path.resolve(workspacePath, path.dirname(marker)))
  );
  const gradleSettingsRoots = markerRoots(['**/settings.gradle', '**/settings.gradle.kts']);
  const gradleRoots = gradleSettingsRoots.length > 0
    ? gradleSettingsRoots
    : markerRoots(['**/build.gradle', '**/build.gradle.kts']);
  const mavenRoots = markerRoots(['**/pom.xml']);
  const bazelRoots = markerRoots(['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel']);
  if (gradleRoots.length > 0) systems.push({ kind: 'gradle', roots: gradleRoots, importMode: 'native' });
  if (mavenRoots.length > 0) systems.push({ kind: 'maven', roots: mavenRoots, importMode: 'native' });
  if (bazelRoots.length > 0) systems.push({ kind: 'bazel', roots: bazelRoots, importMode: 'external-model' });
  return systems;
}

/** Discover independent Java build roots without treating every module as a new workspace. */
export function discoverJavaBuildRoots(repositoryPath: string): JavaBuildRoot[] {
  const repo = path.resolve(repositoryPath);
  const candidates = new Map<string, Set<JavaBuildSystemKind>>();
  const add = (root: string, kind: JavaBuildSystemKind): void => {
    const resolved = path.resolve(root);
    const kinds = candidates.get(resolved) ?? new Set<JavaBuildSystemKind>();
    kinds.add(kind);
    candidates.set(resolved, kinds);
  };
  const markerDirectories = (patterns: string[]): string[] => [...new Set(
    patterns.flatMap((pattern) => globSync(pattern, { cwd: repo, nodir: true, ignore: JAVA_IGNORE }))
      .map((marker) => path.resolve(repo, path.dirname(marker)))
  )];

  const gradleSettingsRoots = markerDirectories(['**/settings.gradle', '**/settings.gradle.kts']);
  for (const root of gradleSettingsRoots) add(root, 'gradle');
  for (const root of markerDirectories(['**/build.gradle', '**/build.gradle.kts'])) {
    if (!gradleSettingsRoots.some((settingsRoot) => isPathInside(root, settingsRoot))) add(root, 'gradle');
  }

  const pomPaths = globSync('**/pom.xml', { cwd: repo, nodir: true, ignore: JAVA_IGNORE });
  const mavenModuleRoots = new Set<string>();
  for (const pomPath of pomPaths) {
    const pomDir = path.resolve(repo, path.dirname(pomPath));
    const xml = fs.readFileSync(path.resolve(repo, pomPath), 'utf8');
    const modules = xml.match(/<modules>([\s\S]*?)<\/modules>/i)?.[1] ?? '';
    for (const match of modules.matchAll(/<module>\s*([^<]+?)\s*<\/module>/gi)) {
      mavenModuleRoots.add(path.resolve(pomDir, match[1].trim()));
    }
  }
  for (const pomPath of pomPaths) {
    const pomDir = path.resolve(repo, path.dirname(pomPath));
    if (!mavenModuleRoots.has(pomDir)) add(pomDir, 'maven');
  }

  for (const root of markerDirectories(['**/MODULE.bazel', '**/WORKSPACE', '**/WORKSPACE.bazel'])) add(root, 'bazel');

  if (candidates.size === 0) candidates.set(repo, new Set());
  const sortedPaths = [...candidates.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots = sortedPaths.map((workspacePath): JavaBuildRoot => {
    const nested = sortedPaths.filter((other) => other !== workspacePath && isPathInside(other, workspacePath));
    const directNested = nested.filter((candidate) => !nested.some((other) =>
      other !== candidate && isPathInside(candidate, other)
    ));
    const systems = [...(candidates.get(workspacePath) ?? [])].sort();
    const relativePath = path.relative(repo, workspacePath) || '.';
    return {
      id: `${systems.join('+') || 'unmanaged'}:${relativePath.split(path.sep).join('/')}`,
      workspacePath,
      relativePath,
      systems,
      excludedRoots: directNested.sort(),
    };
  });

  const hasUnownedJava = globSync('**/*.java', { cwd: repo, nodir: true, ignore: JAVA_IGNORE }).some((file) =>
    ownerBuildRoot(path.resolve(repo, file), roots) === undefined
  );
  if (hasUnownedJava && !roots.some((root) => root.workspacePath === repo)) {
    roots.unshift({
      id: 'unmanaged:.', workspacePath: repo, relativePath: '.', systems: [],
      excludedRoots: roots.filter((root) => !roots.some((other) =>
        other !== root && isPathInside(root.workspacePath, other.workspacePath)
      )).map((root) => root.workspacePath).sort(),
    });
  }
  return roots;
}

export function ownerBuildRoot(filePath: string, roots: JavaBuildRoot[]): JavaBuildRoot | undefined {
  return roots
    .filter((root) => isPathInside(path.resolve(filePath), root.workspacePath))
    .sort((a, b) => b.workspacePath.length - a.workspacePath.length || a.id.localeCompare(b.id))[0];
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function minimalBuildRoots(roots: string[]): string[] {
  const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return sorted.filter((candidate, index) => !sorted.slice(0, index).some((root) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  })).sort();
}

function declaredMavenJavaMajor(workspacePath: string, ignore: string[] = JAVA_IGNORE): number | undefined {
  const majors: number[] = [];
  for (const pom of globSync('**/pom.xml', { cwd: workspacePath, nodir: true, ignore })) {
    const xml = fs.readFileSync(path.join(workspacePath, pom), 'utf8');
    for (const tag of ['java.version', 'maven.compiler.release', 'maven.compiler.source', 'maven.compiler.target']) {
      const match = xml.match(new RegExp(`<${tag}>\\s*(?:1\\.)?(\\d+)\\s*</${tag}>`, 'i'));
      if (match) majors.push(Number.parseInt(match[1], 10));
    }
  }
  return majors.length > 0 ? Math.max(...majors) : undefined;
}

function declaredBazelJavaMajor(workspacePath: string): number | undefined {
  const rcFiles = ['.bazelrc', '.bazelrc.user'].filter((file) => fs.existsSync(path.join(workspacePath, file)));
  const majors: number[] = [];
  for (const rcFile of rcFiles) {
    const content = fs.readFileSync(path.join(workspacePath, rcFile), 'utf8');
    for (const match of content.matchAll(/--(?:tool_)?java_language_version(?:=|\s+)(\d+)/g)) {
      majors.push(Number.parseInt(match[1], 10));
    }
  }
  return majors.length > 0 ? Math.max(...majors) : undefined;
}

function readBazelProjectModel(workspacePath: string): BazelProjectModel | undefined {
  const configuredPath = process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL;
  const modelPath = path.resolve(workspacePath, configuredPath || '.gitnexus/jdtls/bazel-project.json');
  if (!fs.existsSync(modelPath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as {
    classpath?: unknown;
    runtimeClasspath?: unknown;
    sourcePaths?: unknown;
    generatedSourcePaths?: unknown;
    outputPath?: unknown;
    javaMajor?: unknown;
  };
  if (!Array.isArray(parsed.classpath) || !parsed.classpath.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid Bazel JDT model ${modelPath}: classpath must be an array of paths.`);
  }
  if (!Array.isArray(parsed.sourcePaths) || !parsed.sourcePaths.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid Bazel JDT model ${modelPath}: sourcePaths must be an array of paths.`);
  }
  const resolveClasspath = (entry: string): string => path.resolve(workspacePath, entry);
  const resolveWorkspaceRelative = (entry: string, field: string): string => {
    const relative = path.relative(workspacePath, path.resolve(workspacePath, entry));
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Invalid Bazel JDT model ${modelPath}: ${field} must stay inside the workspace.`);
    }
    return relative || '.';
  };
  return {
    modelPath,
    classpath: parsed.classpath.map(resolveClasspath),
    ...(Array.isArray(parsed.runtimeClasspath) && parsed.runtimeClasspath.every((entry) => typeof entry === 'string')
      ? { runtimeClasspath: parsed.runtimeClasspath.map(resolveClasspath) }
      : {}),
    sourcePaths: parsed.sourcePaths.map((entry) => resolveWorkspaceRelative(entry, 'sourcePaths')),
    ...(Array.isArray(parsed.generatedSourcePaths) && parsed.generatedSourcePaths.every((entry) => typeof entry === 'string')
      ? { generatedSourcePaths: parsed.generatedSourcePaths.map(resolveClasspath) }
      : {}),
    ...(typeof parsed.outputPath === 'string' ? { outputPath: resolveWorkspaceRelative(parsed.outputPath, 'outputPath') } : {}),
    ...(typeof parsed.javaMajor === 'number' ? { javaMajor: parsed.javaMajor } : {}),
  };
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  throw new Error(`${name} must be one of 1, 0, true, false, on, or off.`);
}

function buildScanIgnore(workspacePath: string, excludedRoots: string[]): string[] {
  return [
    ...JAVA_IGNORE,
    ...excludedRoots.map((root) => {
      const relative = path.relative(workspacePath, root).split(path.sep).join('/');
      return relative ? `${relative}/**` : '';
    }).filter(Boolean),
  ];
}
