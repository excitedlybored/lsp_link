/**
 * TypeScript / JavaScript LSP Adapter.
 *
 * Runs `typescript-language-server --stdio` for financial web portals and Node.js microservices.
 */

import { BaseStdioLspAdapter } from '../base-stdio-adapter.js';

export class TypeScriptAdapter extends BaseStdioLspAdapter {
  public readonly id = 'typescript-language-server';
  public readonly language = 'typescript';

  public async isAvailable(): Promise<boolean> {
    const bin = BaseStdioLspAdapter.findBinary('typescript-language-server');
    return bin !== null;
  }

  protected async buildProcessLaunch(_workspacePath: string) {
    const bin = BaseStdioLspAdapter.findBinary('typescript-language-server') || 'typescript-language-server';
    return {
      command: bin,
      args: ['--stdio'],
      initializationOptions: {
        preferences: {
          includeInlayParameterNameHints: 'all',
        },
      },
    };
  }
}
