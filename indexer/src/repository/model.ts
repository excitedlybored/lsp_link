import { createHash } from 'node:crypto';

import type { CodeOrigin } from '../code-origin.js';

export type RepositoryDocumentKind = 'source' | 'gherkin' | 'configuration' | 'build_definition';
export type RepositoryIndexingAuthority = 'semantic_lsp' | 'structural_lexical';

export interface RepositoryProviderRun {
  id: string;
  runId: string;
  providerId: string;
  providerVersion: string;
  authority: RepositoryIndexingAuthority;
  languages: string[];
  capabilities: string[];
  includeGlobs: string[];
  status: 'complete' | 'partial' | 'failed';
  discoveredCount: number;
  indexedCount: number;
  skippedCount: number;
  errorCount: number;
  errorsJson: string;
}

export interface RepositoryInventoryRun {
  id: string;
  workspacePath: string;
  status: 'complete' | 'partial';
  documentCount: number;
  declarationCount: number;
}

export interface RepositoryDocument {
  id: string;
  runId: string;
  path: string;
  relativePath: string;
  languageId: string;
  kind: RepositoryDocumentKind;
  contentHash: string;
  byteSize: number;
  lineCount: number;
  codeOrigin: CodeOrigin;
  providerId: string;
  providerVersion: string;
  authority: RepositoryIndexingAuthority;
}

export interface RepositoryDeclaration {
  id: string;
  runId: string;
  documentId: string;
  kind: string;
  name: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  providerId: string;
  providerVersion: string;
  authority: RepositoryIndexingAuthority;
  codeOrigin: CodeOrigin;
}

export interface RepositoryInventoryBatch {
  runs: RepositoryInventoryRun[];
  providers: RepositoryProviderRun[];
  documents: RepositoryDocument[];
  declarations: RepositoryDeclaration[];
}

export function emptyRepositoryInventoryBatch(): RepositoryInventoryBatch {
  return { runs: [], providers: [], documents: [], declarations: [] };
}

export function repositoryStableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}
