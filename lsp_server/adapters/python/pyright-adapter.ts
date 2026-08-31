/**
 * Python Pyright LSP Adapter.
 *
 * Runs `pyright-langserver --stdio` to provide compiler-grade type resolution,
 * call hierarchies, and definitions for Python quant/risk applications.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class PyrightAdapter extends BaseStdioLspAdapter {
  public readonly id = 'pyright';
  public readonly language = 'python';
  public readonly fileExtensions = ['.py', '.pyi'] as const;

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('pyright-langserver');
    return bin !== null;
  }

  protected async buildProcessLaunch(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('pyright-langserver') || 'pyright-langserver';
    return {
      command: bin,
      args: ['--stdio'],
      initializationOptions: {
        python: {
          analysis: {
            typeCheckingMode: 'basic',
            autoSearchPaths: true,
            useLibraryCodeForTypes: true,
          },
        },
      },
    };
  }
}
