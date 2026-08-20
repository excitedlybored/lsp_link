/**
 * Set 1: Standalone LSP Server Daemon Controller (TypeScript).
 *
 * Spawns and manages the Eclipse JDT Language Server process over OpenJDK 21.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { globSync } from 'glob';

export class StandaloneLspServer {
  private process: ChildProcess | null = null;

  constructor(private workspacePath: string) {}

  public start(): ChildProcess {
    const javaBin = this.findJava21();
    const { launcherJar, configDir } = this.findJdtls();
    const dataDir = path.join('/tmp', `jdtls_server_${Date.now()}_${process.pid}`);
    fs.mkdirSync(dataDir, { recursive: true });

    const args = [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=ALL',
      '-noverify',
      '-Xmx2G',
      '-XX:+UseG1GC',
      '-XX:+UseStringDeduplication',
      '--add-modules=ALL-SYSTEM',
      '--add-opens',
      'java.base/java.util=ALL-UNNAMED',
      '--add-opens',
      'java.base/java.lang=ALL-UNNAMED',
      '-jar',
      launcherJar,
      '-configuration',
      configDir,
      '-data',
      dataDir,
    ];

    console.log(`========================================================================`);
    console.log(`⚡ Spawning Standalone Eclipse JDT Language Server (OpenJDK 21)`);
    console.log(`   Workspace: ${this.workspacePath}`);
    console.log(`   Java:      ${javaBin}`);
    console.log(`   Launcher:  ${launcherJar}`);
    console.log(`========================================================================`);

    this.process = spawn(javaBin, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.process.on('exit', (code) => {
      console.log(`[LSP Server] Exited with code ${code}`);
    });

    return this.process;
  }

  private findJava21(): string {
    const candidates = [
      '/opt/homebrew/opt/openjdk@21/bin/java',
      '/opt/homebrew/Cellar/openjdk@21/21.0.6/libexec/openjdk.jdk/Contents/Home/bin/java',
      '/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'java';
  }

  private findJdtls(): { launcherJar: string; configDir: string } {
    const serverDirs = [
      ...globSync(path.join(os.homedir(), '.vscode/extensions/redhat.java-*/server')),
      ...globSync(path.join(os.homedir(), '.cursor/extensions/redhat.java-*/server')),
    ];

    for (const serverDir of serverDirs) {
      const launcherJars = globSync(path.join(serverDir, 'plugins/org.eclipse.equinox.launcher_*.jar'));
      const configDir = fs.existsSync(path.join(serverDir, 'config_mac_arm'))
        ? path.join(serverDir, 'config_mac_arm')
        : path.join(serverDir, 'config_mac');

      if (launcherJars.length > 0 && fs.existsSync(configDir)) {
        return { launcherJar: launcherJars[0], configDir };
      }
    }
    throw new Error('JDT.LS extension not found in ~/.vscode or ~/.cursor');
  }
}

if (process.argv[1] && process.argv[1].endsWith('server_launcher.ts')) {
  const target = process.argv[2] || '.';
  const server = new StandaloneLspServer(path.resolve(process.cwd(), target));
  server.start();
}
