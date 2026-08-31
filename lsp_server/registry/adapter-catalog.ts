import * as path from 'path';
import type { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { CobolAdapter } from '../adapters/cobol/cobol-adapter.js';
import { ClangdAdapter } from '../adapters/cpp/clangd-adapter.js';
import { CSharpAdapter } from '../adapters/csharp/csharp-adapter.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { KotlinLspAdapter } from '../adapters/kotlin/kotlin-lsp-adapter.js';
import { PyrightAdapter } from '../adapters/python/pyright-adapter.js';
import { RustAnalyzerAdapter } from '../adapters/rust/rust-analyzer-adapter.js';
import { TypeScriptAdapter } from '../adapters/typescript/typescript-adapter.js';

export type LspAdapterFactory = () => ILspAdapter;

export interface LspAdapterCatalogEntry {
  id: string;
  language: string;
  fileExtensions: string[];
}

/** Immutable routing metadata plus the construction boundary for LSP sessions. */
export class LspAdapterCatalog {
  private readonly prototypes = new Map<string, ILspAdapter>();
  private readonly factories = new Map<string, LspAdapterFactory>();
  private readonly languageByExtension = new Map<string, string>();

  public constructor(factories: LspAdapterFactory[] = defaultAdapterFactories()) {
    for (const factory of factories) this.registerFactory(factory);
  }

  public registerAdapter(adapter: ILspAdapter): void {
    this.registerMetadata(adapter);
  }

  public registerFactory(factory: LspAdapterFactory): void {
    const prototype = factory();
    const language = prototype.language.toLowerCase();
    this.registerMetadata(prototype);
    this.factories.set(language, factory);
  }

  public getAdapter(language: string): ILspAdapter | undefined {
    return this.prototypes.get(language.toLowerCase());
  }

  public createAdapter(language: string): ILspAdapter | undefined {
    const key = language.toLowerCase();
    return this.factories.get(key)?.() ?? this.prototypes.get(key);
  }

  public getLanguageForFile(filePath: string): string | null {
    return this.languageByExtension.get(path.extname(filePath).toLowerCase()) ?? null;
  }

  public getSupportedFileExtensions(): string[] {
    return [...this.languageByExtension.keys()].sort();
  }

  public entries(): LspAdapterCatalogEntry[] {
    return [...this.prototypes.values()].map((adapter) => ({
      id: adapter.id,
      language: adapter.language.toLowerCase(),
      fileExtensions: [...(adapter.fileExtensions ?? [])].map((value) => value.toLowerCase()).sort(),
    })).sort((left, right) => left.language.localeCompare(right.language));
  }

  private registerMetadata(adapter: ILspAdapter): void {
    const language = adapter.language.toLowerCase();
    if (this.prototypes.has(language)) {
      throw new Error(`LSP adapter is already registered for ${language}`);
    }
    this.prototypes.set(language, adapter);
    for (const rawExtension of adapter.fileExtensions ?? []) {
      const extension = rawExtension.toLowerCase();
      if (!/^\.[a-z0-9][a-z0-9.+-]*$/.test(extension)) {
        throw new Error(`Invalid file extension for ${adapter.id}: ${rawExtension}`);
      }
      const current = this.languageByExtension.get(extension);
      if (current && current !== language) {
        throw new Error(`File extension ${extension} is already routed to ${current}`);
      }
      this.languageByExtension.set(extension, language);
    }
  }
}

export function defaultAdapterFactories(): LspAdapterFactory[] {
  return [
    () => new JavaJdtlsAdapter(),
    () => new KotlinLspAdapter(),
    () => new PyrightAdapter(),
    () => new ClangdAdapter(),
    () => new RustAnalyzerAdapter(),
    () => new TypeScriptAdapter(),
    () => new CSharpAdapter(),
    () => new CobolAdapter(),
  ];
}
