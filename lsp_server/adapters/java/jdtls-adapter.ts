/**
 * Eclipse JDT.LS Adapter implementing ILspAdapter.
 *
 * Uses the same vscode-jsonrpc transport as other languages. Initialize is not
 * hard-capped at 45s — the compiler handshake is allowed to finish. After
 * `initialized`, we wait for `language/status ServiceReady` with a wait that
 * scales with project size (a cap, not a skip).
 */

import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';
import { resolveJdtlsConfig } from './jdtls-launcher.js';

export class JavaJdtlsAdapter extends BaseStdioLspAdapter {
  public readonly id = 'jdtls';
  public readonly language = 'java';

  private serviceReady = false;
  private serviceReadyResolve: (() => void) | null = null;
  private javaFileCount = 0;
  private lastStatusAt = 0;

  public async isAvailable(): Promise<boolean> {
    try {
      resolveJdtlsConfig();
      return true;
    } catch {
      return false;
    }
  }

  protected handleNotification(method: string, params: unknown): void {
    if (method !== 'language/status') return;
    this.lastStatusAt = Date.now();
    const type = (params as { type?: string } | null)?.type;
    if (type === 'ServiceReady' || type === 'Started') {
      this.serviceReady = true;
      this.serviceReadyResolve?.();
    }
  }

  protected initializeTimeoutMs(_workspacePath: string): number | undefined {
    return Math.min(600_000, Math.max(180_000, this.javaFileCount * 80));
  }

  protected async afterHandshake(_workspacePath: string): Promise<void> {
    if (this.serviceReady) return;
    const readyTimeoutMs = Math.min(900_000, Math.max(180_000, this.javaFileCount * 120));
    await Promise.race([
      new Promise<void>((resolve) => {
        this.serviceReadyResolve = resolve;
        if (this.serviceReady) resolve();
      }),
      new Promise<void>((resolve) => setTimeout(resolve, readyTimeoutMs)),
    ]);

    // ServiceReady can fire before Maven/Gradle import finishes. Wait until
    // status notifications go quiet so call-hierarchy sees compiled types.
    const quietMs = 1500;
    const settleCapMs = Math.min(60_000, Math.max(8_000, this.javaFileCount * 4));
    const settleStart = Date.now();
    while (Date.now() - settleStart < settleCapMs) {
      const idleFor = Date.now() - (this.lastStatusAt || settleStart);
      if (idleFor >= quietMs) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  protected async getLaunchConfig(workspacePath: string) {
    const { javaBin, launcherJar, configDir } = resolveJdtlsConfig();
    const hash = Buffer.from(path.resolve(workspacePath)).toString('base64url').slice(0, 16);
    const dataDir = path.join('/tmp', `gitnexus_jdtls_${hash}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const hasPom = fs.existsSync(path.join(workspacePath, 'pom.xml'));
    const hasGradle =
      fs.existsSync(path.join(workspacePath, 'build.gradle')) ||
      fs.existsSync(path.join(workspacePath, 'build.gradle.kts')) ||
      fs.existsSync(path.join(workspacePath, 'settings.gradle')) ||
      fs.existsSync(path.join(workspacePath, 'settings.gradle.kts'));

    this.javaFileCount = globSync('**/*.java', {
      cwd: workspacePath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/build/**', '**/target/**', '**/.git/**'],
    }).length;
    const xmx = this.javaFileCount > 2000 ? '4G' : '2G';

    return {
      command: javaBin,
      args: [
        '-Declipse.application=org.eclipse.jdt.ls.core.id1',
        '-Dosgi.bundles.defaultStartLevel=4',
        '-Declipse.product=org.eclipse.jdt.ls.core.product',
        '-Dlog.level=WARNING',
        '-XX:TieredStopAtLevel=1',
        '-Xms512M',
        `-Xmx${xmx}`,
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
      ],
      initOptions: {
        settings: {
          java: {
            autobuild: { enabled: true },
            import: {
              gradle: { enabled: hasGradle },
              maven: { enabled: hasPom },
            },
          },
        },
      },
    };
  }
}
