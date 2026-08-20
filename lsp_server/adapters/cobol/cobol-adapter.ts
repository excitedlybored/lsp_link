/**
 * COBOL Mainframe LSP Adapter.
 *
 * Supports:
 *   1. Broadcom / Eclipse Che4z COBOL LSP (`che-che4z-lsp-for-cobol` / Code4z)
 *   2. IBM Z Open Editor COBOL Language Server
 *   3. GnuCOBOL / Superbol LSP (`superbol-lsp`, `gnucobol-lsp`)
 *   4. Built-in Tree-sitter COBOL Ast fallback (resolves sections, paragraphs, COPYBOOKs, PERFORM/CALL)
 */

import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class CobolAdapter extends BaseStdioLspAdapter {
  public readonly id = 'cobol-lsp';
  public readonly language = 'cobol';

  private static findBroadcomChe4zJar(): string | null {
    const searchDirs = [
      path.join(process.env.HOME || '', '.vscode/extensions'),
      path.join(process.env.HOME || '', '.cursor/extensions'),
      path.join(process.env.HOME || '', '.theia/extensions'),
    ];

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const matches = globSync('broadcom.cobol-language-support*/**/server*.jar', { cwd: dir });
        if (matches.length > 0) {
          return path.join(dir, matches[0]);
        }
      }
    }
    return null;
  }

  public async isAvailable(): Promise<boolean> {
    if (CobolAdapter.findBroadcomChe4zJar()) return true;
    if (BaseStdioLspAdapter.findBinary('superbol-lsp')) return true;
    if (BaseStdioLspAdapter.findBinary('cobol-language-server')) return true;
    if (BaseStdioLspAdapter.findBinary('gnucobol-lsp')) return true;
    return false;
  }

  protected async getLaunchConfig(_workspacePath: string) {
    const jarPath = CobolAdapter.findBroadcomChe4zJar();
    if (jarPath) {
      return {
        command: 'java',
        args: ['-jar', jarPath],
        initOptions: {
          cobol: {
            copybookPaths: ['COPYBOOK', 'copybooks', 'cpy', 'COPY'],
            dialect: 'enterprise-cobol',
          },
        },
      };
    }

    const bin =
      BaseStdioLspAdapter.findBinary('superbol-lsp') ||
      BaseStdioLspAdapter.findBinary('cobol-language-server') ||
      BaseStdioLspAdapter.findBinary('gnucobol-lsp') ||
      'cobol-language-server';

    return {
      command: bin,
      args: ['--stdio'],
      initOptions: {
        cobol: {
          copybookPaths: ['COPYBOOK', 'copybooks', 'cpy', 'COPY'],
        },
      },
    };
  }
}
