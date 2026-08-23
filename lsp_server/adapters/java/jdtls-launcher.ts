/**
 * Eclipse JDT.LS Runtime Discovery & Launcher.
 *
 * JDT.LS (redhat.java 1.40+) needs a JDK 21+ runtime. That is independent of
 * the project's source level — we still index every Java file; we just start
 * the compiler on a JVM it can actually run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { globSync } from 'glob';

export interface JdtlsLaunchConfig {
  javaBin: string;
  launcherJar: string;
  configDir: string;
}

function versionHint(javaBin: string): number {
  const text = javaBin;
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
    const m = text.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

export function findJavaBinary(): string {
  const candidates = [
    ...globSync('/opt/homebrew/opt/openjdk@*/bin/java'),
    ...globSync('/opt/homebrew/opt/openjdk/bin/java'),
    ...globSync('/opt/homebrew/Cellar/openjdk*/*/libexec/openjdk.jdk/Contents/Home/bin/java'),
    ...globSync('/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java'),
    ...globSync(path.join(os.homedir(), 'Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java')),
  ];

  if (process.env.JAVA_HOME) {
    const fromHome = path.join(process.env.JAVA_HOME, 'bin', 'java');
    if (fs.existsSync(fromHome)) candidates.push(fromHome);
  }

  const unique = [...new Set(candidates.filter((p) => fs.existsSync(p)))];
  if (unique.length === 0) return 'java';

  const scored = unique.map((bin) => ({ bin, version: versionHint(bin) }));
  const lts21 = scored.filter((s) => s.version === 21);
  if (lts21.length > 0) return lts21[0].bin;
  const jdk21 = scored.filter((s) => s.version >= 21).sort((a, b) => b.version - a.version);
  if (jdk21.length > 0) return jdk21[0].bin;

  scored.sort((a, b) => b.version - a.version);
  return scored[0].bin;
}

export function findJdtlsLauncher(): { launcherJar: string; configDir: string } {
  const serverDirs = [
    ...globSync(path.join(os.homedir(), '.vscode/extensions/redhat.java-*/server')),
    ...globSync(path.join(os.homedir(), '.cursor/extensions/redhat.java-*/server')),
  ];

  for (const serverDir of serverDirs) {
    const launcherJars = globSync(path.join(serverDir, 'plugins/org.eclipse.equinox.launcher_*.jar'));
    const configMacArm = path.join(serverDir, 'config_mac_arm');
    const configMac = path.join(serverDir, 'config_mac');
    const configLinux = path.join(serverDir, 'config_linux');
    const configWin = path.join(serverDir, 'config_win');
    const configDir = [configMacArm, configMac, configLinux, configWin].find((d) => fs.existsSync(d));

    if (launcherJars.length > 0 && configDir) {
      return {
        launcherJar: launcherJars[0],
        configDir,
      };
    }
  }

  throw new Error('Eclipse JDT.LS launcher not found in ~/.vscode/extensions or ~/.cursor/extensions.');
}

export function resolveJdtlsConfig(): JdtlsLaunchConfig {
  const javaBin = findJavaBinary();
  const { launcherJar, configDir } = findJdtlsLauncher();
  return { javaBin, launcherJar, configDir };
}
