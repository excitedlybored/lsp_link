/**
 * JDT.LS runtime: JDK 21+ for the compiler process, Equinox launcher jars,
 * workspace size, and the JVM command line.
 *
 * The project's source level is unchanged — every `.java` file is still
 * indexed. The compiler itself simply cannot boot on JDK 17.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { globSync } from 'glob';

export interface JdtlsRuntime {
  jdkJavaBin: string;
  equinoxLauncherJar: string;
  osgiConfigDir: string;
}

export interface JdtlsProcessLaunch {
  command: string;
  args: string[];
  initializationOptions: Record<string, unknown>;
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

  static locate(): JdtlsRuntime {
    const { equinoxLauncherJar, osgiConfigDir } = JdtlsRuntimeLocator.findEquinoxInstall();
    return {
      jdkJavaBin: JdtlsRuntimeLocator.selectCompilerJdk(),
      equinoxLauncherJar,
      osgiConfigDir,
    };
  }

  /** JDT.LS (redhat.java 1.40+) needs JDK 21+. Never boot the compiler on 17. */
  private static selectCompilerJdk(): string {
    const candidates = [
      ...globSync('/opt/homebrew/opt/openjdk@21/bin/java'),
      ...globSync('/opt/homebrew/opt/openjdk@2*/bin/java'),
      ...globSync('/opt/homebrew/opt/openjdk/bin/java'),
      ...globSync('/opt/homebrew/Cellar/openjdk@21/*/libexec/openjdk.jdk/Contents/Home/bin/java'),
      ...globSync('/opt/homebrew/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home/bin/java'),
      ...globSync('/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java'),
      ...globSync(path.join(os.homedir(), 'Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java')),
    ];

    if (process.env.JAVA_HOME) {
      const fromHome = path.join(process.env.JAVA_HOME, 'bin', 'java');
      if (fs.existsSync(fromHome)) candidates.unshift(fromHome);
    }

    const unique = [...new Set(candidates.filter((p) => fs.existsSync(p)))];
    const scored = unique.map((bin) => ({ bin, version: jdkMajorVersionFromPath(bin) }));
    const jdk21OrNewer = scored.filter((s) => s.version >= 21).sort((a, b) => {
      if (a.version !== b.version) return a.version === 21 ? -1 : b.version === 21 ? 1 : b.version - a.version;
      return 0;
    });
    if (jdk21OrNewer.length > 0) return jdk21OrNewer[0].bin;

    throw new Error(
      'JDT.LS requires JDK 21+. Install Homebrew openjdk@21 or set JAVA_HOME to a JDK 21+ home. JDK 17 cannot run redhat.java 1.55.'
    );
  }

  private static findEquinoxInstall(): { equinoxLauncherJar: string; osgiConfigDir: string } {
    const serverDirs = [
      ...globSync(path.join(os.homedir(), '.vscode/extensions/redhat.java-*/server')),
      ...globSync(path.join(os.homedir(), '.cursor/extensions/redhat.java-*/server')),
    ];

    for (const serverDir of serverDirs) {
      const launcherJars = globSync(path.join(serverDir, 'plugins/org.eclipse.equinox.launcher_*.jar'));
      const osgiConfigDir = [
        path.join(serverDir, 'config_mac_arm'),
        path.join(serverDir, 'config_mac'),
        path.join(serverDir, 'config_linux'),
        path.join(serverDir, 'config_win'),
      ].find((dir) => fs.existsSync(dir));

      if (launcherJars.length > 0 && osgiConfigDir) {
        return { equinoxLauncherJar: launcherJars[0], osgiConfigDir };
      }
    }

    throw new Error('Eclipse JDT.LS launcher not found in ~/.vscode/extensions or ~/.cursor/extensions.');
  }
}

/** Project shape used to size heap, initialize wait, and Maven/Gradle import. */
export class JdtlsWorkspace {
  readonly sourceFileCount: number;
  readonly usesMaven: boolean;
  readonly usesGradle: boolean;

  private constructor(sourceFileCount: number, usesMaven: boolean, usesGradle: boolean) {
    this.sourceFileCount = sourceFileCount;
    this.usesMaven = usesMaven;
    this.usesGradle = usesGradle;
  }

  static inspect(workspacePath: string): JdtlsWorkspace {
    const sourceFileCount = globSync('**/*.java', {
      cwd: workspacePath,
      nodir: true,
      ignore: JAVA_IGNORE,
    }).length;

    const usesMaven = fs.existsSync(path.join(workspacePath, 'pom.xml'));
    const usesGradle =
      fs.existsSync(path.join(workspacePath, 'build.gradle')) ||
      fs.existsSync(path.join(workspacePath, 'build.gradle.kts')) ||
      fs.existsSync(path.join(workspacePath, 'settings.gradle')) ||
      fs.existsSync(path.join(workspacePath, 'settings.gradle.kts'));

    return new JdtlsWorkspace(sourceFileCount, usesMaven, usesGradle);
  }

  heapXmx(): string {
    if (this.sourceFileCount > 5000) return '6G';
    if (this.sourceFileCount > 2000) return '4G';
    return '2G';
  }

  initializeTimeoutMs(): number {
    return Math.min(180_000, Math.max(60_000, this.sourceFileCount * 20));
  }

  serviceReadyTimeoutMs(): number {
    return Math.min(180_000, Math.max(30_000, this.sourceFileCount * 20));
  }

  importQuietTimeoutMs(): number {
    return Math.min(180_000, Math.max(8_000, this.sourceFileCount * 20));
  }
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

  return {
    command: runtime.jdkJavaBin,
    args: jdtlsVmArguments({
      runtime,
      dataDir: resolvedDataDir,
      heapXmx: workspace.heapXmx(),
    }),
    initializationOptions: {
      extendedClientCapabilities: {
        skipProjectConfiguration: true,
        classFileContentsSupport: true,
        shouldLanguageServerExitOnShutdown: true,
      },
      settings: {
        java: {
          autobuild: { enabled: false },
          maxConcurrentBuilds: 1,
          errors: { incompleteClasspath: { severity: 'ignore' } },
          configuration: { updateBuildConfiguration: 'disabled' },
          project: {
            importOnFirstTimeStartup: 'disabled',
            resourceFilters: ['node_modules', '.git', 'build', 'target', '.gradle'],
          },
          import: {
            gradle: { enabled: false },
            maven: { enabled: false },
            exclusions: [
              '**/node_modules/**',
              '**/.git/**',
              '**/build/**',
              '**/target/**',
              '**/.gradle/**',
            ],
          },
        },
      },
    },
  };
}

function defaultWorkspaceDataDir(workspacePath: string): string {
  const hash = Buffer.from(path.resolve(workspacePath)).toString('base64url').slice(0, 16);
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
