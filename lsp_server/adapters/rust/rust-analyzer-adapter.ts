/**
 * Rust Analyzer LSP Adapter.
 *
 * Runs `rust-analyzer` for memory-safe trading engines and blockchain/DeFi payment rails.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class RustAnalyzerAdapter extends BaseStdioLspAdapter {
  public readonly id = 'rust-analyzer';
  public readonly language = 'rust';
  public readonly fileExtensions = ['.rs'] as const;

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('rust-analyzer');
    return bin !== null;
  }

  protected async buildProcessLaunch(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('rust-analyzer') || 'rust-analyzer';
    return {
      command: bin,
      args: [],
      initializationOptions: {
        cargo: { allFeatures: true },
        checkOnSave: { command: 'clippy' },
      },
    };
  }
}
