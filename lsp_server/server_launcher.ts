/**
 * Standalone JDT.LS daemon for the query CLI.
 *
 * Reuses JdtlsRuntimeLocator so the daemon and the indexer pick the same JDK 21+
 * compiler runtime.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  JdtlsRuntimeLocator,
  JdtlsWorkspace,
  jdtlsVmArguments,
} from './adapters/java/jdtls-runtime.js';

export class StandaloneLspServer {
  private process: ChildProcess | null = null;

  constructor(private workspacePath: string) {}

  public start(): ChildProcess {
    const runtime = JdtlsRuntimeLocator.locate();
    const workspace = JdtlsWorkspace.inspect(this.workspacePath);
    const dataDir = path.join('/tmp', `jdtls_server_${Date.now()}_${process.pid}`);
    fs.mkdirSync(dataDir, { recursive: true });

    const args = jdtlsVmArguments({
      runtime,
      dataDir,
      heapXmx: workspace.heapXmx(),
    });

    console.log(`========================================================================`);
    console.log(`⚡ Spawning Standalone Eclipse JDT Language Server`);
    console.log(`   Workspace: ${this.workspacePath}`);
    console.log(`   Java:      ${runtime.jdkJavaBin}`);
    console.log(`   Launcher:  ${runtime.equinoxLauncherJar}`);
    console.log(`========================================================================`);

    this.process = spawn(runtime.jdkJavaBin, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.process.on('exit', (code) => {
      console.log(`[LSP Server] Exited with code ${code}`);
    });

    return this.process;
  }
}

if (process.argv[1] && process.argv[1].endsWith('server_launcher.ts')) {
  const target = process.argv[2] || '.';
  const server = new StandaloneLspServer(path.resolve(process.cwd(), target));
  server.start();
}
