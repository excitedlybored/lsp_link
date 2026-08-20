/**
 * Polyglot LSP Adapter Registry & Factory.
 *
 * Registers all banking language adapters and automatically dispatches
 * requests based on file extensions.
 */

import * as path from 'path';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { PyrightAdapter } from '../adapters/python/pyright-adapter.js';
import { ClangdAdapter } from '../adapters/cpp/clangd-adapter.js';
import { RustAnalyzerAdapter } from '../adapters/rust/rust-analyzer-adapter.js';
import { TypeScriptAdapter } from '../adapters/typescript/typescript-adapter.js';
import { CSharpAdapter } from '../adapters/csharp/csharp-adapter.js';
import { CobolAdapter } from '../adapters/cobol/cobol-adapter.js';

export class LspAdapterRegistry {
  private adapters = new Map<string, ILspAdapter>();
  private activeAdapters = new Map<string, ILspAdapter>();

  private static EXTENSION_MAP: Record<string, string> = {
    '.java': 'java',
    '.py': 'python',
    '.pyi': 'python',
    '.c': 'cpp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.rs': 'rust',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.cs': 'csharp',
    '.cbl': 'cobol',
    '.cob': 'cobol',
    '.cpy': 'cobol',
  };

  constructor() {
    this.registerAdapter(new JavaJdtlsAdapter());
    this.registerAdapter(new PyrightAdapter());
    this.registerAdapter(new ClangdAdapter());
    this.registerAdapter(new RustAnalyzerAdapter());
    this.registerAdapter(new TypeScriptAdapter());
    this.registerAdapter(new CSharpAdapter());
    this.registerAdapter(new CobolAdapter());
  }

  public registerAdapter(adapter: ILspAdapter): void {
    this.adapters.set(adapter.language.toLowerCase(), adapter);
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.adapters.get(language.toLowerCase());
  }

  public getLanguageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return LspAdapterRegistry.EXTENSION_MAP[ext] || null;
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

  public async getOrStartAdapterForFile(filePath: string, workspacePath: string): Promise<ILspAdapter | null> {
    const lang = this.getLanguageForFile(filePath);
    if (!lang) return null;
    return this.getOrStartAdapter(lang, workspacePath);
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
