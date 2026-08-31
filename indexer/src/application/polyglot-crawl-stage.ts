import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';

import { dedupeObservationBatch, mergeObservationBatches, type LspObservationBatch } from '../ingest/batch.js';
import { ingestRun } from '../ingest/builders.js';
import { crawlLspBuildRoot, workspaceDocument } from '../ingest/crawler.js';
import type { LspAnalysisRun, LspBuildRoot, LspServer } from '../model.js';
import type { CrawlProfile } from '../ingest/crawl-profile.js';
import type { RepositoryInventoryBatch } from '../repository/model.js';
import { LspAdapterRegistry } from '../../../lsp_server/registry/lsp-adapter-registry.js';

export interface PolyglotCrawlRequest {
  workspacePath: string;
  run: LspAnalysisRun;
  repositoryInventory: RepositoryInventoryBatch;
  adapterRegistry: LspAdapterRegistry;
  profile: CrawlProfile;
  semanticSourcePaths?: string[];
}

const SEMANTIC_SOURCE_IGNORE = [
  '**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**',
  '**/bazel-*/**', '**/.gradle/**', '**/.idea/**', '**/dist/**', '**/coverage/**',
];

/** Source discovery is derived exclusively from adapter routing metadata. */
export function discoverRegisteredSemanticSources(
  workspacePath: string,
  adapterRegistry: LspAdapterRegistry,
): string[] {
  const patterns = adapterRegistry.getSupportedFileExtensions()
    .filter((extension) => extension !== '.java')
    .map((extension) => `**/*${extension}`);
  if (patterns.length === 0) return [];
  return globSync(patterns, {
    cwd: workspacePath, absolute: true, nodir: true, ignore: SEMANTIC_SOURCE_IGNORE,
  }).sort();
}

/**
 * Crawls adapter-routed source languages through registered generic adapters.
 * Java is excluded because its build-root/classpath-aware provider owns Java semantics.
 */
export async function crawlRegisteredRepositoryLanguages(
  request: PolyglotCrawlRequest,
): Promise<LspObservationBatch> {
  const groups = new Map<string, string[]>();
  for (const document of request.repositoryInventory.documents) {
    if (document.kind !== 'source' || document.languageId === 'java') continue;
    const routedLanguage = request.adapterRegistry.getLanguageForFile(document.path);
    if (!routedLanguage || routedLanguage !== document.languageId) continue;
    const files = groups.get(routedLanguage) ?? [];
    files.push(document.path);
    groups.set(routedLanguage, files);
  }
  for (const filePath of request.semanticSourcePaths
    ?? discoverRegisteredSemanticSources(request.workspacePath, request.adapterRegistry)) {
    const language = request.adapterRegistry.getLanguageForFile(filePath);
    if (!language || language === 'java') continue;
    const files = groups.get(language) ?? [];
    files.push(path.resolve(filePath));
    groups.set(language, files);
  }

  const batches: LspObservationBatch[] = [];
  for (const [language, files] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (!request.run.requestedLanguages.includes(language)) request.run.requestedLanguages.push(language);
    const root = genericBuildRoot(request.run, request.workspacePath, language);
    const server = genericServer(request.run, root, language);
    const documents = [...new Set(files)].sort().map((file) =>
      workspaceDocument(file, root.id, 'workspace', language));
    const adapter = await request.adapterRegistry.getOrStartAdapter(language, request.workspacePath);
    if (!adapter) {
      server.status = 'failed';
      request.run.errorCount += 1;
      request.run.status = 'partial';
      batches.push(ingestRun(request.run, [server], documents, [root]));
      continue;
    }
    const serverInfo = adapter.getServerCapabilities().__serverInfo as {
      name?: string; version?: string;
    } | undefined;
    server.name = serverInfo?.name ?? adapter.id;
    server.version = serverInfo?.version;
    server.capabilitiesJson = JSON.stringify(adapter.getServerCapabilities());
    try {
      const batch = await crawlLspBuildRoot({
        run: request.run,
        server,
        buildRoot: root,
        documents,
        adapter,
        repositoryPath: request.workspacePath,
        profile: request.profile,
      });
      const errors = batch.coverage.reduce((sum, value) => sum + value.failureCount, 0);
      const timeouts = batch.coverage.reduce((sum, value) => sum + value.timeoutCount, 0);
      request.run.errorCount += errors;
      request.run.timeoutCount += timeouts;
      server.status = errors > 0 || timeouts > 0 ? 'partial' : 'complete';
      if (server.status === 'partial') request.run.status = 'partial';
      batches.push(batch);
    } catch (error) {
      server.status = 'failed';
      request.run.errorCount += 1;
      request.run.status = 'partial';
      batches.push(ingestRun(request.run, [server], documents, [root]));
      console.warn(`[${language}] semantic crawl failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await request.adapterRegistry.shutdownAdapter(adapter);
    }
  }
  request.run.requestedLanguages.sort();
  request.run.completedAt = new Date().toISOString();
  return dedupeObservationBatch(mergeObservationBatches(...batches));
}

function genericBuildRoot(run: LspAnalysisRun, workspacePath: string, language: string): LspBuildRoot {
  return {
    id: `${language}:workspace`, runId: run.id, workspaceUri: pathToFileURL(workspacePath).href,
    repositoryPath: workspacePath, relativePath: '.', buildSystems: [], importStatus: 'ready',
    excludedRootIds: [],
  };
}

function genericServer(run: LspAnalysisRun, root: LspBuildRoot, language: string): LspServer {
  return {
    id: `server:${run.id}:${root.id}`, runId: run.id, name: language, languageId: language,
    status: 'partial', capabilitiesJson: '{}', buildRootId: root.id,
  };
}
