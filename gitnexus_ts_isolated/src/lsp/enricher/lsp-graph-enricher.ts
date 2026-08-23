/**
 * Walks the knowledge graph with live language servers and writes compiler-
 * accurate CALLS / IMPLEMENTS edges. Does not drop files, languages, or symbols.
 *
 * 1. GraphSymbolIndex: one pass, then O(1) match per LSP result.
 * 2. Language servers start in parallel (Java is not queued behind TS/Python).
 * 3. Work is grouped by file: didOpen → query symbols in that file → didClose.
 * 4. In-flight RPCs follow adapter.maxConcurrentRequests (1 for Java).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../graph/types.js';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { GraphSymbolIndex } from './graph-symbol-index.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
}

interface FileEnrichmentWork {
  interfaces: GraphNode[];
  callables: GraphNode[];
}

interface EnrichmentTargets {
  filesByLanguage: Map<string, Set<string>>;
  callables: GraphNode[];
  interfaces: GraphNode[];
  nameCounts: Map<string, number>;
}

export class LspGraphEnricher {
  constructor(private registry: LspAdapterRegistry = new LspAdapterRegistry()) {}

  public async enrich(
    graph: KnowledgeGraph,
    repoPath: string,
    onProgress?: (msg: string) => void
  ): Promise<EnricherStats> {
    const stats: EnricherStats = {
      enrichedCalls: 0,
      enrichedImplementations: 0,
      conflictsResolved: 0,
    };

    const targets = collectEnrichmentTargets(graph, (filePath) =>
      this.registry.getLanguageForFile(filePath)
    );
    if (targets.filesByLanguage.size === 0) return stats;

    const index = GraphSymbolIndex.fromGraph(graph);

    try {
      await Promise.all(
        [...targets.filesByLanguage.entries()].map(async ([language, files]) => {
          let adapter: ILspAdapter | null = null;
          try {
            adapter = await this.registry.getOrStartAdapter(language, repoPath);
          } catch {
            adapter = null;
          }
          if (!adapter) return;

          onProgress?.(`⚡ Enriching ${language.toUpperCase()} symbols via ${adapter.id}...`);
          await this.enrichLanguage(
            adapter,
            files,
            repoPath,
            graph,
            index,
            targets,
            stats,
            (done, total) => {
              onProgress?.(
                `⚡ Enriching ${language.toUpperCase()} via ${adapter.id}: ${done}/${total} files`
              );
            }
          );
        })
      );
    } finally {
      await this.registry.shutdownAll();
    }

    return stats;
  }

  private async enrichLanguage(
    adapter: ILspAdapter,
    files: Set<string>,
    repoPath: string,
    graph: KnowledgeGraph,
    index: GraphSymbolIndex,
    targets: EnrichmentTargets,
    stats: EnricherStats,
    onFileProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const workByFile = groupWorkByFile(
      targets.interfaces.filter((node) => files.has(node.properties?.filePath || '')),
      targets.callables.filter(
        (node) =>
          files.has(node.properties?.filePath || '') &&
          !isTrivialAccessor(node, targets.nameCounts)
      )
    );

    const fileEntries = [...workByFile.entries()];
    let done = 0;
    await mapWithConcurrency(
      fileEntries,
      async ([relFile, work]) => {
        await this.enrichSourceFile(adapter, repoPath, relFile, work, graph, index, stats);
        done += 1;
        if (done === 1 || done === fileEntries.length || done % 50 === 0) {
          onFileProgress?.(done, fileEntries.length);
        }
      },
      adapter.maxConcurrentRequests
    );
  }

  private async enrichSourceFile(
    adapter: ILspAdapter,
    repoPath: string,
    relFile: string,
    work: FileEnrichmentWork,
    graph: KnowledgeGraph,
    index: GraphSymbolIndex,
    stats: EnricherStats
  ): Promise<void> {
    const absPath = path.resolve(repoPath, relFile);
    const lineAt = sourceLineReader(absPath);

    try {
      await adapter.openDocument(absPath);

      for (const ifaceNode of work.interfaces) {
        await this.enrichImplementations(adapter, absPath, repoPath, ifaceNode, lineAt, graph, index, stats);
      }
      for (const callableNode of work.callables) {
        await this.enrichOutgoingCalls(adapter, absPath, repoPath, callableNode, lineAt, graph, index, stats);
      }
    } finally {
      try {
        await adapter.closeDocument(absPath);
      } catch {
        // Ignore close errors
      }
    }
  }

  private async enrichImplementations(
    adapter: ILspAdapter,
    absPath: string,
    repoPath: string,
    ifaceNode: GraphNode,
    lineAt: (line1: number) => string,
    graph: KnowledgeGraph,
    index: GraphSymbolIndex,
    stats: EnricherStats
  ): Promise<void> {
    const startLine = ifaceNode.properties?.startLine ?? 1;
    try {
      const implementations = await adapter.findImplementations(
        absPath,
        startLine - 1,
        columnOfSymbol(ifaceNode, lineAt(startLine))
      );
      for (const impl of implementations) {
        const implFile = repoPathFromLspUri(impl.uri, repoPath);
        const typeNode = index.primaryTypeInFile(implFile);
        if (!typeNode) continue;
        graph.addRelationship({
          id: `rel:lsp_impl:${typeNode.id}->${ifaceNode.id}`,
          sourceId: typeNode.id,
          targetId: ifaceNode.id,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: `LSP: ${adapter.id} textDocument/implementation`,
        });
        stats.enrichedImplementations += 1;
      }
    } catch {
      // Ignore individual interface lookup errors
    }
  }

  private async enrichOutgoingCalls(
    adapter: ILspAdapter,
    absPath: string,
    repoPath: string,
    callableNode: GraphNode,
    lineAt: (line1: number) => string,
    graph: KnowledgeGraph,
    index: GraphSymbolIndex,
    stats: EnricherStats
  ): Promise<void> {
    const startLine = callableNode.properties?.startLine ?? 1;
    try {
      const items = await adapter.prepareCallHierarchy(
        absPath,
        startLine - 1,
        columnOfSymbol(callableNode, lineAt(startLine))
      );
      if (!items || items.length === 0) return;

      const outgoing = await adapter.getOutgoingCalls(items[0]);
      for (const call of outgoing) {
        const targetFile = repoPathFromLspUri(call.to.uri, repoPath);
        const rawTargetName = call.to.name;
        const simpleTargetName = rawTargetName.split('(')[0].trim();
        const targetNode = index.findCallableOrType(targetFile, simpleTargetName);
        if (!targetNode || targetNode.id === callableNode.id) continue;

        stats.conflictsResolved += index.dropConflictingHeuristicCalls(
          graph,
          callableNode.id,
          targetFile,
          targetNode.id
        );

        graph.addRelationship({
          id: `rel:lsp_call:${callableNode.id}->${targetNode.id}`,
          sourceId: callableNode.id,
          targetId: targetNode.id,
          type: 'CALLS',
          confidence: 1.0,
          reason: `LSP: ${adapter.id} Call Hierarchy (${rawTargetName})`,
        });
        stats.enrichedCalls += 1;
      }
    } catch {
      // Ignore individual callable lookup errors
    }
  }
}

function collectEnrichmentTargets(
  graph: KnowledgeGraph,
  languageForFile: (filePath: string) => string | null
): EnrichmentTargets {
  const filesByLanguage = new Map<string, Set<string>>();
  const callables: GraphNode[] = [];
  const interfaces: GraphNode[] = [];
  const nameCounts = new Map<string, number>();

  const nodes = graph.iterNodes ? graph.iterNodes() : graph.nodes ?? [];
  for (const node of nodes) {
    const filePath = node.properties?.filePath;
    if (!filePath) continue;

    const language = languageForFile(filePath);
    if (language) {
      let files = filesByLanguage.get(language);
      if (!files) {
        files = new Set();
        filesByLanguage.set(language, files);
      }
      files.add(filePath);
    }

    if (node.label === 'Method' || node.label === 'Function' || node.label === 'Constructor') {
      callables.push(node);
      const name = node.properties?.name || '';
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    } else if (node.label === 'Interface' || node.label === 'Trait') {
      interfaces.push(node);
    }
  }

  return { filesByLanguage, callables, interfaces, nameCounts };
}

function groupWorkByFile(
  interfaces: GraphNode[],
  callables: GraphNode[]
): Map<string, FileEnrichmentWork> {
  const workByFile = new Map<string, FileEnrichmentWork>();
  for (const node of interfaces) {
    const filePath = node.properties?.filePath;
    if (!filePath) continue;
    let work = workByFile.get(filePath);
    if (!work) {
      work = { interfaces: [], callables: [] };
      workByFile.set(filePath, work);
    }
    work.interfaces.push(node);
  }
  for (const node of callables) {
    const filePath = node.properties?.filePath;
    if (!filePath) continue;
    let work = workByFile.get(filePath);
    if (!work) {
      work = { interfaces: [], callables: [] };
      workByFile.set(filePath, work);
    }
    work.callables.push(node);
  }
  return workByFile;
}

/** One-line get/set with a unique name is not worth a call-hierarchy RPC. */
function isTrivialAccessor(node: GraphNode, nameCounts: Map<string, number>): boolean {
  const name = node.properties?.name || '';
  const startLine = node.properties?.startLine ?? 1;
  const endLine = node.properties?.endLine ?? startLine;
  return (
    endLine - startLine <= 1 &&
    (nameCounts.get(name) || 0) <= 1 &&
    (name.startsWith('get') || name.startsWith('set'))
  );
}

function columnOfSymbol(node: GraphNode, lineText: string): number {
  const named = node.properties?.startCol ?? node.properties?.column;
  if (typeof named === 'number' && named >= 0) return named;
  const name = node.properties?.name || '';
  if (!name) return 0;
  const idx = lineText.indexOf(name);
  return idx >= 0 ? idx : 0;
}

function sourceLineReader(absPath: string): (line1: number) => string {
  let lines: string[] | null = null;
  return (line1: number): string => {
    if (!lines) {
      try {
        lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
      } catch {
        lines = [];
      }
    }
    return lines[Math.max(0, line1 - 1)] ?? '';
  };
}

function repoPathFromLspUri(uri: string, repoPath: string): string {
  const abs = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  return path.relative(repoPath, abs);
}

async function mapWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const pending: Promise<void> = Promise.resolve()
      .then(() => fn(item))
      .catch(() => undefined);
    executing.add(pending);
    pending.finally(() => executing.delete(pending));
    if (executing.size >= limit) await Promise.race(executing);
  }

  await Promise.all(executing);
}
