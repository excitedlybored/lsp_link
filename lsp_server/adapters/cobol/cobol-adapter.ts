/**
 * COBOL Mainframe LSP Adapter.
 *
 * Connects to `cobol-language-server`, `gnucobol-lsp`, or IBM Z Open Editor engine
 * for core banking ledgers, CICS transactions, and batch payroll programs.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class CobolAdapter extends BaseStdioLspAdapter {
  public readonly id = 'cobol-lsp';
  public readonly language = 'cobol';

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('cobol-language-server') || BaseStdioLspAdapter.findBinary('gnucobol-lsp');
    return bin !== null;
  }

  protected async getLaunchConfig(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('cobol-language-server') || BaseStdioLspAdapter.findBinary('gnucobol-lsp') || 'cobol-language-server';
    return {
      command: bin,
      args: ['--stdio'],
      initOptions: {
        cobol: {
          copybookPaths: ['COPYBOOK', 'copybooks', 'cpy'],
        },
      },
    };
  }
}
