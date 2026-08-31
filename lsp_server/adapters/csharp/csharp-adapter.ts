/**
 * C# / .NET LSP Adapter.
 *
 * Connects to `csharp-ls` or `OmniSharp` for commercial treasury platforms and .NET services.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class CSharpAdapter extends BaseStdioLspAdapter {
  public readonly id = 'csharp-ls';
  public readonly language = 'csharp';
  public readonly fileExtensions = ['.cs'] as const;
  public readonly maxConcurrentRequests = 1;

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('csharp-ls') || BaseStdioLspAdapter.findBinary('OmniSharp');
    return bin !== null;
  }

  protected async buildProcessLaunch(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('csharp-ls') || BaseStdioLspAdapter.findBinary('OmniSharp') || 'csharp-ls';
    return {
      command: bin,
      args: ['-lsp'],
      initializationOptions: {},
    };
  }
}
