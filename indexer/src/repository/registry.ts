import type { IRepositoryDocumentProvider } from './provider.js';
import { ConfigurationDocumentProvider } from './providers/configuration.js';
import { GherkinDocumentProvider } from './providers/gherkin.js';
import { KotlinDocumentProvider } from './providers/kotlin.js';
import { StarlarkDocumentProvider } from './providers/starlark.js';

export class RepositoryDocumentProviderRegistry {
  private readonly providers = new Map<string, IRepositoryDocumentProvider>();

  constructor(providers: IRepositoryDocumentProvider[] = defaultRepositoryDocumentProviders()) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: IRepositoryDocumentProvider): void {
    if (!/^[a-z][a-z0-9-]*$/.test(provider.metadata.id)) {
      throw new Error(`Invalid repository document provider id: ${provider.metadata.id}`);
    }
    if (provider.metadata.languages.length === 0 || provider.metadata.includeGlobs.length === 0) {
      throw new Error(`Repository document provider ${provider.metadata.id} requires languages and includeGlobs`);
    }
    if (this.providers.has(provider.metadata.id)) {
      throw new Error(`Repository document provider is already registered: ${provider.metadata.id}`);
    }
    if (provider.metadata.authority === 'semantic_lsp') {
      throw new Error(
        `Structural provider ${provider.metadata.id} cannot claim semantic_lsp authority; register an ILspAdapter`,
      );
    }
    this.providers.set(provider.metadata.id, provider);
  }

  all(): IRepositoryDocumentProvider[] {
    return [...this.providers.values()];
  }

  providerFor(relativePath: string): IRepositoryDocumentProvider | undefined {
    const matches = this.all().filter((provider) => provider.supports(relativePath));
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous repository document providers for ${relativePath}: `
        + matches.map((provider) => provider.metadata.id).join(', '),
      );
    }
    return matches[0];
  }
}

export function defaultRepositoryDocumentProviders(): IRepositoryDocumentProvider[] {
  return [
    new KotlinDocumentProvider(),
    new GherkinDocumentProvider(),
    new StarlarkDocumentProvider(),
    new ConfigurationDocumentProvider(),
  ];
}
