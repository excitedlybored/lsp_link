/**
 * LSP Adapter Registry & Factory with Automatic Fallback.
 */

import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';

export class LspAdapterRegistry {
  private adapters = new Map<string, ILspAdapter>();
  private activeAdapters = new Map<string, ILspAdapter>();

  constructor() {
    this.registerAdapter(new JavaJdtlsAdapter());
  }

  public registerAdapter(adapter: ILspAdapter): void {
    this.adapters.set(adapter.language.toLowerCase(), adapter);
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.adapters.get(language.toLowerCase());
  }

  public async getOrStartAdapter(language: string, workspacePath: string): Promise<ILspAdapter | null> {
    const langKey = language.toLowerCase();
    if (this.activeAdapters.has(langKey)) {
      return this.activeAdapters.get(langKey)!;
    }

    const adapter = this.getAdapter(langKey);
    if (!adapter) {
      return null;
    }

    try {
      const available = await adapter.isAvailable();
      if (!available) {
        return null;
      }

      await adapter.start(workspacePath);
      this.activeAdapters.set(langKey, adapter);
      return adapter;
    } catch (err: any) {
      console.warn(`[LSP Registry] Failed to start adapter for ${language}:`, err.message || err);
      return null;
    }
  }

  public async shutdownAll(): Promise<void> {
    for (const adapter of this.activeAdapters.values()) {
      try {
        await adapter.shutdown();
      } catch {
        // Ignore error on shutdown
      }
    }
    this.activeAdapters.clear();
  }
}
