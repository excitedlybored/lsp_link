import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'glob';

import { mapConcurrently } from '../pipeline/concurrency.js';
import {
  repositoryStableId,
  type RepositoryDeclaration,
  type RepositoryDocument,
  type RepositoryInventoryBatch,
  type RepositoryProviderRun,
} from './model.js';
import type { IRepositoryDocumentProvider } from './provider.js';
import { RepositoryDocumentProviderRegistry } from './registry.js';
import { addConfigurationEvidence, type ConfigurationEvidenceOptions } from './configuration-evidence.js';

const INVENTORY_IGNORE = [
  '**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**',
  '**/bazel-*/**', '**/.gradle/**', '**/.idea/**', '**/dist/**', '**/coverage/**',
];

export interface RepositoryInventoryOptions {
  concurrency?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
  configuration?: ConfigurationEvidenceOptions;
}

interface RoutedFile {
  absolutePath: string;
  relativePath: string;
  provider: IRepositoryDocumentProvider;
}

interface IndexedFile {
  document?: RepositoryDocument;
  declarations: RepositoryDeclaration[];
  providerId: string;
  error?: string;
  skipped: boolean;
}

/** Runs independently registered structural providers with bounded I/O. */
export async function buildRepositoryInventory(
  workspacePath: string,
  options: RepositoryInventoryOptions = {},
  registry = new RepositoryDocumentProviderRegistry(),
): Promise<RepositoryInventoryBatch> {
  const workspace = path.resolve(workspacePath);
  const runId = repositoryStableId('repository-inventory', workspace);
  const concurrency = positiveInteger(options.concurrency, 4, 'repository inventory concurrency');
  const maxFileBytes = positiveInteger(options.maxFileBytes, 4 * 1024 * 1024, 'repository inventory maxFileBytes');
  const routed = routeFiles(workspace, registry);
  const providerStates = new Map(registry.all().map((provider) => [
    provider.metadata.id,
    providerRun(runId, provider, routed.filter((file) => file.provider === provider).length),
  ]));
  const started: IRepositoryDocumentProvider[] = [];
  const activeProviderIds = new Set<string>();
  let batch: RepositoryInventoryBatch | undefined;
  try {
    for (const provider of registry.all()) {
      if ((providerStates.get(provider.metadata.id)?.discoveredCount ?? 0) === 0) continue;
      try {
        await provider.start?.(workspace, options.signal);
        started.push(provider);
        activeProviderIds.add(provider.metadata.id);
      } catch (error) {
        const state = providerStates.get(provider.metadata.id)!;
        state.status = 'failed';
        state.errorCount = 1;
        state.errorsJson = JSON.stringify([
          `startup: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
    }
    const indexed = await mapConcurrently(
      routed.filter((file) => activeProviderIds.has(file.provider.metadata.id)),
      concurrency, async (file) =>
      indexFile(workspace, runId, file, maxFileBytes, options.signal));
    const documents = indexed.flatMap((value) => value.document ? [value.document] : []);
    const declarations = indexed.flatMap((value) => value.declarations);
    for (const result of indexed) updateProviderState(providerStates.get(result.providerId)!, result);
    batch = {
      runs: [{
        id: runId, workspacePath: workspace,
        status: [...providerStates.values()].some((value) => value.status !== 'complete')
          ? 'partial' : 'complete',
        documentCount: documents.length, declarationCount: declarations.length,
      }],
      providers: [...providerStates.values()], documents, declarations,
      configurationKeys: [], configurationValues: [], configurationReferences: [], deploymentUnits: [],
    };
    if (options.configuration) await addConfigurationEvidence(batch, options.configuration);
    return batch;
  } finally {
    for (const provider of started.reverse()) {
      try {
        await provider.shutdown?.();
      } catch (error) {
        const state = providerStates.get(provider.metadata.id)!;
        state.errorCount += 1;
        const errors = JSON.parse(state.errorsJson) as string[];
        if (errors.length < 100) {
          errors.push(`shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
        state.errorsJson = JSON.stringify(errors);
        state.status = 'partial';
      }
    }
    if (batch && [...providerStates.values()].some((value) => value.status !== 'complete')) {
      batch.runs[0]!.status = 'partial';
    }
  }
}

function routeFiles(workspace: string, registry: RepositoryDocumentProviderRegistry): RoutedFile[] {
  const patterns = [...new Set(registry.all().flatMap((provider) => provider.metadata.includeGlobs))];
  return globSync(patterns, {
    cwd: workspace, absolute: true, nodir: true, ignore: INVENTORY_IGNORE,
  }).sort().flatMap((absolutePath) => {
    const relativePath = path.relative(workspace, absolutePath).split(path.sep).join('/');
    const provider = registry.providerFor(relativePath);
    return provider ? [{ absolutePath, relativePath, provider }] : [];
  });
}

async function indexFile(
  workspace: string,
  runId: string,
  file: RoutedFile,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<IndexedFile> {
  const metadata = file.provider.metadata;
  try {
    if (signal?.aborted) throw new Error('repository inventory aborted');
    const stat = await fs.stat(file.absolutePath);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > maxFileBytes) {
      return {
        declarations: [], providerId: metadata.id, skipped: true,
        error: `file exceeds ${maxFileBytes} byte limit: ${file.relativePath}`,
      };
    }
    const content = await fs.readFile(file.absolutePath, 'utf8');
    const document: RepositoryDocument = {
      id: repositoryStableId('repository-document', workspace, file.relativePath),
      runId, path: file.absolutePath, relativePath: file.relativePath,
      languageId: file.provider.languageId(file.relativePath), kind: metadata.documentKind,
      contentHash: createHash('sha256').update(content).digest('hex'),
      byteSize: Buffer.byteLength(content), lineCount: lineCount(content), codeOrigin: 'repository',
      providerId: metadata.id, providerVersion: metadata.version, authority: metadata.authority,
    };
    const declarations = (await file.provider.index({ document, content, signal })).map((value) => ({
      ...value,
      id: repositoryStableId(
        'repository-declaration', document.id, value.kind, value.name,
        String(value.startLine), String(value.startCharacter), metadata.id, metadata.version,
      ),
      runId, documentId: document.id, codeOrigin: 'repository' as const,
      providerId: metadata.id, providerVersion: metadata.version, authority: metadata.authority,
    }));
    return { document, declarations, providerId: metadata.id, skipped: false };
  } catch (error) {
    return {
      declarations: [], providerId: metadata.id, skipped: false,
      error: `${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function providerRun(
  runId: string,
  provider: IRepositoryDocumentProvider,
  discoveredCount: number,
): RepositoryProviderRun {
  const metadata = provider.metadata;
  return {
    id: repositoryStableId('repository-provider-run', runId, metadata.id, metadata.version),
    runId, providerId: metadata.id, providerVersion: metadata.version,
    authority: metadata.authority, languages: [...metadata.languages],
    capabilities: [...metadata.capabilities], includeGlobs: [...metadata.includeGlobs], status: 'complete',
    discoveredCount, indexedCount: 0, skippedCount: 0, errorCount: 0, errorsJson: '[]',
  };
}

function updateProviderState(state: RepositoryProviderRun, result: IndexedFile): void {
  if (result.document) state.indexedCount += 1;
  if (result.skipped) state.skippedCount += 1;
  if (result.error) {
    state.errorCount += 1;
    const errors = JSON.parse(state.errorsJson) as string[];
    if (errors.length < 100) errors.push(result.error);
    state.errorsJson = JSON.stringify(errors);
  }
  state.status = state.errorCount > 0 || state.skippedCount > 0 ? 'partial' : 'complete';
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}
