/** Official JetBrains Kotlin Language Server adapter. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BaseStdioLspAdapter, type StdioProcessLaunch } from '../base-stdio-adapter.js';

const VENDORED_KOTLIN_LSP_VERSION = '262.9593.0';

export class KotlinLspAdapter extends BaseStdioLspAdapter {
  public readonly id = 'kotlin-lsp';
  public readonly language = 'kotlin';
  public readonly fileExtensions = ['.kt', '.kts'] as const;
  public readonly maxConcurrentRequests = 1;

  private systemPath?: string;

  public async isAvailable(): Promise<boolean> {
    return this.binary() !== null;
  }

  public override async shutdown(): Promise<void> {
    try {
      await super.shutdown();
    } finally {
      if (this.systemPath) {
        fs.rmSync(this.systemPath, { recursive: true, force: true });
        this.systemPath = undefined;
      }
    }
  }

  protected initializeTimeoutMs(): number {
    return 180_000;
  }

  protected queryTimeoutMs(): number {
    return 60_000;
  }

  protected async buildProcessLaunch(_workspacePath: string): Promise<StdioProcessLaunch> {
    const command = this.binary();
    if (!command) throw new Error('Official Kotlin language server is not installed');
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    this.systemPath = fs.mkdtempSync(path.join(temporaryRoot, 'gitnexus-kotlin-lsp-'));
    return {
      command,
      args: ['--stdio', '--system-path', this.systemPath, '--log-level', 'WARNING'],
      initializationOptions: {},
    };
  }

  private binary(): string | null {
    const configured = process.env.GITNEXUS_KOTLIN_LSP_BIN?.trim();
    if (configured) return fs.existsSync(configured) ? path.resolve(configured) : null;

    const bundled = findBundledKotlinLsp(process.cwd());
    if (bundled) return bundled;
    return BaseStdioLspAdapter.findBinary('kotlin-lsp');
  }
}

export function findBundledKotlinLsp(
  start: string,
  platform = process.platform,
  architecture = process.arch,
): string | null {
  if (!((platform === 'linux' && architecture === 'x64')
    || (platform === 'darwin' && architecture === 'arm64'))) return null;
  for (const workspaceRoot of ancestorDirectories(start)) {
    const bundled = path.join(
      workspaceRoot,
      '.gitnexus',
      'tools',
      'kotlin-lsp',
      VENDORED_KOTLIN_LSP_VERSION,
      'bin',
      'intellij-server',
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  return null;
}

function* ancestorDirectories(start: string): IterableIterator<string> {
  let current = path.resolve(start);
  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
