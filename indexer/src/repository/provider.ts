import type {
  RepositoryDocument,
  RepositoryDocumentKind,
  RepositoryIndexingAuthority,
} from './model.js';

export interface RepositoryProviderMetadata {
  id: string;
  version: string;
  authority: RepositoryIndexingAuthority;
  languages: readonly string[];
  capabilities: readonly string[];
  includeGlobs: readonly string[];
  documentKind: RepositoryDocumentKind;
}

export interface RepositoryProviderContext {
  document: RepositoryDocument;
  content: string;
  signal?: AbortSignal;
}

export interface RepositoryDeclarationInput {
  kind: string;
  name: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * Pluggable non-semantic indexing boundary.
 *
 * A provider owns file routing and structural observations for one format
 * family. Semantic language servers continue to implement ILspAdapter; a
 * structural provider must never advertise semantic-lsp authority.
 */
export interface IRepositoryDocumentProvider {
  readonly metadata: RepositoryProviderMetadata;
  supports(relativePath: string): boolean;
  languageId(relativePath: string): string;
  start?(workspacePath: string, signal?: AbortSignal): Promise<void>;
  index(context: RepositoryProviderContext): Promise<RepositoryDeclarationInput[]>;
  shutdown?(): Promise<void>;
}
