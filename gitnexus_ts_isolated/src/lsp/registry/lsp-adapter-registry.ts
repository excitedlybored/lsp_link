/**
 * Polyglot LSP Adapter Registry & Factory.
 *
 * Registers all banking language adapters and automatically dispatches
 * requests based on file extensions.
 */

import * as path from 'path';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { discoverJavaBuildRoots, JavaBuildRoot, ownerBuildRoot } from '../adapters/java/jdtls-runtime.js';
import { PyrightAdapter } from '../adapters/python/pyright-adapter.js';
import { ClangdAdapter } from '../adapters/cpp/clangd-adapter.js';
import { RustAnalyzerAdapter } from '../adapters/rust/rust-analyzer-adapter.js';
import { TypeScriptAdapter } from '../adapters/typescript/typescript-adapter.js';
import { CSharpAdapter } from '../adapters/csharp/csharp-adapter.js';
import { CobolAdapter } from '../adapters/cobol/cobol-adapter.js';

export class LspAdapterRegistry {
  private adapters = new Map<string, ILspAdapter>();
  private activeAdapters = new Map<string, ILspAdapter>();
  private javaLayouts = new Map<string, JavaBuildRoot[]>();

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
    const sessionKey = `${langKey}:${path.resolve(workspacePath)}`;
    if (this.activeAdapters.has(sessionKey)) {
      return this.activeAdapters.get(sessionKey)!;
    }

    const adapter = this.createAdapter(langKey);
    if (!adapter) {
      return null;
    }

    try {
      const available = await adapter.isAvailable();
      if (!available) {
        return null;
      }

      await adapter.start(workspacePath);
      this.activeAdapters.set(sessionKey, adapter);
      return adapter;
    } catch (err: any) {
      console.warn(`[LSP Registry] Failed to start adapter for ${language}:`, err.message || err);
      try {
        await adapter.shutdown();
      } catch {
        // Ignore errors tearing down a partially-started adapter
      }
      return null;
    }
  }

  public async getOrStartAdapterForFile(filePath: string, workspacePath: string): Promise<ILspAdapter | null> {
    const lang = this.getLanguageForFile(filePath);
    if (!lang) return null;
    if (lang === 'java') {
      const roots = this.getJavaBuildRoots(workspacePath);
      const root = ownerBuildRoot(filePath, roots);
      if (root) return this.getOrStartJavaBuildRoot(root);
    }
    return this.getOrStartAdapter(lang, workspacePath);
  }

  public getJavaBuildRoots(repositoryPath: string): JavaBuildRoot[] {
    const key = path.resolve(repositoryPath);
    const cached = this.javaLayouts.get(key);
    if (cached) return cached;
    const roots = discoverJavaBuildRoots(key);
    this.javaLayouts.set(key, roots);
    return roots;
  }

  public async getOrStartJavaBuildRoot(root: JavaBuildRoot): Promise<ILspAdapter | null> {
    const sessionKey = `java:${root.id}:${root.workspacePath}`;
    const active = this.activeAdapters.get(sessionKey);
    if (active) return active;
    const adapter = new JavaJdtlsAdapter({
      buildRootId: root.id,
      buildSystems: root.systems,
      excludedRoots: root.excludedRoots,
    });
    try {
      if (!(await adapter.isAvailable())) return null;
      await adapter.start(root.workspacePath);
      this.activeAdapters.set(sessionKey, adapter);
      return adapter;
    } catch (err: any) {
      console.warn(`[LSP Registry] Failed to start Java build root ${root.id}:`, err.message || err);
      try { await adapter.shutdown(); } catch { /* partial startup */ }
      return null;
    }
  }

  private createAdapter(language: string): ILspAdapter | undefined {
    switch (language) {
      case 'java': return new JavaJdtlsAdapter();
      case 'python': return new PyrightAdapter();
      case 'cpp': return new ClangdAdapter();
      case 'rust': return new RustAnalyzerAdapter();
      case 'typescript': return new TypeScriptAdapter();
      case 'csharp': return new CSharpAdapter();
      case 'cobol': return new CobolAdapter();
      default: return this.getAdapter(language);
    }
  }

  public async shutdownAdapter(adapter: ILspAdapter): Promise<void> {
    try { await adapter.shutdown(); } catch { /* best-effort session cleanup */ }
    for (const [key, active] of this.activeAdapters) {
      if (active === adapter) this.activeAdapters.delete(key);
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
    this.javaLayouts.clear();
  }
}
