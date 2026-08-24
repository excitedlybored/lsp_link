import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import lbug from '@ladybugdb/core';
import {
  LSP_RELATION_KIND,
  symbolKindName,
  symbolNodeTable,
  type LspAnalysisRun,
  type LspBuildRoot,
  type LspCoverage,
  type LspDocument,
  type LspEntityKind,
  type LspRelation,
  type LspServer,
  type LspSymbol,
  type LspSymbolKindName,
} from './model.js';
import { emptyObservationBatch, mergeObservationBatches } from './ingest/batch.js';
import { ingestRun } from './ingest/builders.js';
import { openLspLadybugDatabase, type LadybugModuleLike } from './lbug/repository.js';

interface ProjectedNode {
  id: string; label: string; name: string; filePath: string; uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  kind: number; buildRootId?: string;
}
interface ProjectedEdge {
  id: string; sourceId: string; targetId: string;
  type: 'DEFINES' | 'CONTAINS' | 'CALLS' | 'IMPLEMENTS' | 'REFERENCES';
  confidence: number; reason: string; buildRootId?: string;
}
interface ProjectedGraph {
  repoPath: string; indexedAt: string; lspServer: string;
  buildRoots: Array<{
    id: string; path: string; systems: string[];
    importStatus?: 'ready' | 'disabled' | 'failed'; configurationHash?: string;
  }>;
  nodes: ProjectedNode[]; relationships: ProjectedEdge[];
}

function documentId(uri: string): string { return `document:${uri}`; }

export function projectedGraphToBatch(graph: ProjectedGraph) {
  const runId = `run:${graph.indexedAt}`;
  const run: LspAnalysisRun = {
    id: runId, workspaceUri: pathToFileURL(graph.repoPath).href, repositoryPath: graph.repoPath,
    protocolVersion: '3.17', positionEncoding: 'utf-16', status: 'complete',
    startedAt: graph.indexedAt, completedAt: graph.indexedAt,
    requestedLanguages: ['java'], errorCount: 0, timeoutCount: 0,
  };
  const roots: LspBuildRoot[] = graph.buildRoots.map((root) => ({
    id: root.id, runId, workspaceUri: pathToFileURL(path.join(graph.repoPath, root.path)).href,
    repositoryPath: path.join(graph.repoPath, root.path), relativePath: root.path,
    buildSystems: root.systems, importStatus: root.importStatus ?? 'ready',
    configurationHash: root.configurationHash, excludedRootIds: [],
  }));
  const servers: LspServer[] = roots.map((root) => ({
    id: `server:${root.id}`, runId, name: graph.lspServer, languageId: 'java',
    status: 'complete', capabilitiesJson: '{}', buildRootId: root.id,
  }));
  const isFileNode = (node: ProjectedNode): boolean => node.id.startsWith('file:file://');
  const fileNodes = graph.nodes.filter(isFileNode);
  const documents: LspDocument[] = fileNodes.map((node) => ({
    id: documentId(node.uri), uri: node.uri, filePath: node.filePath, languageId: 'java',
    origin: 'workspace', wasOpened: true, buildRootId: node.buildRootId,
  }));
  const batch = mergeObservationBatches(ingestRun(run, servers, documents, roots), emptyObservationBatch());
  const documentUris = new Set(documents.map((document) => document.uri));
  const symbols = new Map<string, LspSymbol>();
  for (const node of graph.nodes) {
    if (isFileNode(node) || !documentUris.has(node.uri)) continue;
    const kindName = symbolKindName(node.kind);
    if (kindName === 'Unknown') continue;
    const symbol = {
      id: node.id, documentId: documentId(node.uri), uri: node.uri, name: node.name,
      kind: node.kind, kindName, tags: [], range: node.range, selectionRange: node.range,
      stableKey: node.id, isExternal: false,
    } as LspSymbol;
    symbols.set(node.id, symbol);
    batch.symbols.push(symbol);
  }
  const serverByRoot = new Map(servers.map((server) => [server.buildRootId, server.id]));
  for (const edge of graph.relationships) {
    const target = symbols.get(edge.targetId);
    if (!target) continue;
    const sourceSymbol = symbols.get(edge.sourceId);
    const sourceDocument = fileNodes.find((node) => node.id === edge.sourceId);
    let kind: LspRelation['kind'] | undefined;
    let sourceKind: LspEntityKind | undefined;
    let sourceId: string | undefined;
    if (edge.type === 'DEFINES' && sourceDocument) {
      kind = LSP_RELATION_KIND.Defines; sourceKind = 'LspDocument'; sourceId = documentId(sourceDocument.uri);
    } else if (edge.type === 'CONTAINS' && sourceSymbol) {
      kind = LSP_RELATION_KIND.Contains; sourceKind = symbolNodeTable(sourceSymbol.kindName); sourceId = sourceSymbol.id;
    } else if (edge.type === 'IMPLEMENTS' && sourceSymbol) {
      kind = LSP_RELATION_KIND.ImplementationOf; sourceKind = symbolNodeTable(sourceSymbol.kindName); sourceId = sourceSymbol.id;
    }
    if (!kind || !sourceKind || !sourceId) continue;
    batch.relations.push({
      id: `relation:${edge.id}`, sourceKind, sourceId,
      targetKind: symbolNodeTable(target.kindName), targetId: target.id, kind, runId,
      serverId: serverByRoot.get(edge.buildRootId), capability: edge.reason,
      status: 'mapped', providerAuthority: 1, mappingConfidence: edge.confidence,
      isDerived: edge.type === 'IMPLEMENTS', reason: edge.reason,
    });
  }
  const capabilityCounts = new Map<string, number>();
  for (const edge of graph.relationships) capabilityCounts.set(edge.type, (capabilityCounts.get(edge.type) ?? 0) + 1);
  const coverage: LspCoverage[] = ['DEFINES', 'CONTAINS', 'IMPLEMENTS', 'CALLS', 'REFERENCES'].map((capability) => {
    const count = capabilityCounts.get(capability) ?? 0;
    const lossy = capability === 'CALLS' || capability === 'REFERENCES';
    return { id: `coverage:${runId}:${capability}`, runId, languageId: 'java', capability,
      status: lossy ? 'excluded' : count ? 'mapped' : 'empty', eligibleCount: count,
      attemptedCount: count, successCount: lossy ? 0 : count, emptyCount: count ? 0 : 1,
      failureCount: 0, timeoutCount: 0, resultCount: count, mappedCount: lossy ? 0 : count,
      externalCount: 0, unmappedCount: lossy ? count : 0,
      exclusionReason: lossy ? 'Projected JSON lacks native call-site/occurrence observations' : undefined };
  });
  batch.coverage.push(...coverage);
  return batch;
}

async function main() {
  const workspace = path.resolve(process.argv[2] ?? '.');
  const input = path.join(workspace, '.gitnexus', 'lsp-graph.json');
  const output = path.join(workspace, '.gitnexus', 'lsp-lbug');
  const graph = JSON.parse(fs.readFileSync(input, 'utf8')) as ProjectedGraph;
  const batch = projectedGraphToBatch(graph);
  const handle = openLspLadybugDatabase(output, lbug as unknown as LadybugModuleLike);
  try { await handle.repository.initializeSchema(); await handle.repository.writeBatch(batch); }
  finally { await handle.close(); }
  console.log(JSON.stringify({ output, runs: batch.analysisRuns.length, buildRoots: batch.buildRoots.length,
    documents: batch.documents.length, symbols: batch.symbols.length, relations: batch.relations.length,
    coverage: batch.coverage.length }, null, 2));
}

if (process.argv[1]?.includes('import-graph')) main().catch((error) => { console.error(error); process.exit(1); });
