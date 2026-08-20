/**
 * Eclipse JDT.LS Runtime Discovery & Launcher.
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

export function findJava21Binary(): string {
  const candidates = [
    '/opt/homebrew/opt/openjdk@21/bin/java',
    '/opt/homebrew/Cellar/openjdk@21/21.0.6/libexec/openjdk.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'java';
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
    const configDir = fs.existsSync(configMacArm) ? configMacArm : configMac;

    if (launcherJars.length > 0 && fs.existsSync(configDir)) {
      return {
        launcherJar: launcherJars[0],
        configDir,
      };
    }
  }

  throw new Error('Eclipse JDT.LS launcher not found in ~/.vscode/extensions or ~/.cursor/extensions.');
}

export function resolveJdtlsConfig(): JdtlsLaunchConfig {
  const javaBin = findJava21Binary();
  const { launcherJar, configDir } = findJdtlsLauncher();
  return { javaBin, launcherJar, configDir };
}
