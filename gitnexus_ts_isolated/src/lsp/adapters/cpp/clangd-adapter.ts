/**
 * C / C++ Clangd LSP Adapter.
 *
 * Runs `clangd` (LLVM) for HFT, low-latency market making, and derivative pricing engines.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class ClangdAdapter extends BaseStdioLspAdapter {
  public readonly id = 'clangd';
  public readonly language = 'cpp';
  public readonly maxConcurrentRequests = 1;

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('clangd');
    return bin !== null;
  }

  protected async buildProcessLaunch(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('clangd') || 'clangd';
    return {
      command: bin,
      args: ['--background-index', '--header-insertion=never', '--all-scopes-completion'],
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: ['-std=c++20'],
      },
    };
  }
}
