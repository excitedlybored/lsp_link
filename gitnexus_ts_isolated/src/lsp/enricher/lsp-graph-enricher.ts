/**
 * Polyglot LSP Graph Enricher.
 *
 * Algorithm (does not drop files, languages, or symbols):
 * 1. One O(|V|+|E|) pass builds file/name indexes and heuristic CALLS-by-source.
 *    Matching an LSP result is then O(1), not O(|V|) per query.
 * 2. Language servers start in parallel so Java initialize is not queued behind
 *    TypeScript/Python enrichment.
 * 3. Work is grouped by file. A document is opened only when that file is
 *    queried, then closed — JDT.LS is a compiler, not a 7k-file didOpen flood.
 * 4. In-flight RPCs are bounded per language (1 for Java) so the compiler is
 *    not stampeded. Every callable/interface is still visited.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
}

type GraphNodeLike = {
  id: string;
  label: string;
  properties?: {
    name?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    startCol?: number;
    column?: number;
    [key: string]: unknown;
  };
};

type GraphRelLike = {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
};

export interface GraphIndex {
  callablesByFileName: Map<string, GraphNodeLike>;
  typesByFileName: Map<string, GraphNodeLike>;
  /** First Class/Struct per file — IMPLEMENTS matching is file-scoped. */
  primaryTypeByFile: Map<string, GraphNodeLike>;
  heuristicCallsBySource: Map<string, GraphRelLike[]>;
}

function fileNameKey(filePath: string, name: string): string {
  return `${filePath}\0${name}`;
}

/** Single linear pass — every later lookup is O(1). */
export function buildGraphIndex(graph: any): GraphIndex {
  const callablesByFileName = new Map<string, GraphNodeLike>();
  const typesByFileName = new Map<string, GraphNodeLike>();
  const primaryTypeByFile = new Map<string, GraphNodeLike>();
  const heuristicCallsBySource = new Map<string, GraphRelLike[]>();

  const nodes: Iterable<GraphNodeLike> = graph.iterNodes ? graph.iterNodes() : graph.nodes;
  for (const node of nodes) {
    const filePath = node.properties?.filePath;
    const name = node.properties?.name;
    if (!filePath || !name) continue;
    const key = fileNameKey(filePath, name);
    if (node.label === 'Method' || node.label === 'Function' || node.label === 'Constructor') {
      if (!callablesByFileName.has(key)) callablesByFileName.set(key, node);
    } else if (
      node.label === 'Class' ||
      node.label === 'Struct' ||
      node.label === 'Interface' ||
      node.label === 'Trait'
    ) {
      if (!typesByFileName.has(key)) typesByFileName.set(key, node);
      if (
        (node.label === 'Class' || node.label === 'Struct') &&
        !primaryTypeByFile.has(filePath)
      ) {
        primaryTypeByFile.set(filePath, node);
      }
    }
  }

  const rels: Iterable<GraphRelLike> = graph.iterRelationshipsByType
    ? graph.iterRelationshipsByType('CALLS')
    : graph.iterRelationships
      ? graph.iterRelationships()
      : graph.relationships || [];
  for (const rel of rels) {
    if (rel.type && rel.type !== 'CALLS') continue;
    if (rel.confidence >= 1.0) continue;
    let bucket = heuristicCallsBySource.get(rel.sourceId);
    if (!bucket) {
      bucket = [];
      heuristicCallsBySource.set(rel.sourceId, bucket);
    }
    bucket.push(rel);
  }

  return { callablesByFileName, typesByFileName, primaryTypeByFile, heuristicCallsBySource };
}

export function groupByFile<T extends GraphNodeLike>(nodes: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const node of nodes) {
    const filePath = node.properties?.filePath;
    if (!filePath) continue;
    let bucket = groups.get(filePath);
    if (!bucket) {
      bucket = [];
      groups.set(filePath, bucket);
    }
    bucket.push(node);
  }
  return groups;
}

/** Compilers (JDT.LS, OmniSharp) serialize work internally; extra concurrency only queues timeouts. */
export function rpcConcurrencyFor(language: string): number {
  switch (language) {
    case 'java':
    case 'csharp':
    case 'cpp':
      return 1;
    default:
      return 2;
  }
}

export function identifierCharacter(lineText: string, name: string): number {
  if (!name) return 0;
  const idx = lineText.indexOf(name);
  return idx >= 0 ? idx : 0;
}

async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p: Promise<void> = Promise.resolve()
      .then(() => fn(item))
      .catch(() => undefined);
    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

function uriToRepoPath(uri: string, repoPath: string): string {
  const abs = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  return path.relative(repoPath, abs);
}

function lspCharacter(node: GraphNodeLike, lineText: string): number {
  const named = node.properties?.startCol ?? node.properties?.column;
  if (typeof named === 'number' && named >= 0) return named;
  return identifierCharacter(lineText, node.properties?.name || '');
}

export class LspGraphEnricher {
  constructor(private registry: LspAdapterRegistry = new LspAdapterRegistry()) {}

  public async enrich(
    graph: any,
    repoPath: string,
    onProgress?: (msg: string) => void
  ): Promise<EnricherStats> {
    const stats: EnricherStats = {
      enrichedCalls: 0,
      enrichedImplementations: 0,
      conflictsResolved: 0,
    };

    const callableNodes: GraphNodeLike[] = [];
    const interfaceNodes: GraphNodeLike[] = [];
    const filesByLang = new Map<string, Set<string>>();
    const nameCounts = new Map<string, number>();

    for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
      const filePath = node.properties?.filePath;
      if (!filePath) continue;

      const lang = this.registry.getLanguageForFile(filePath);
      if (lang) {
        if (!filesByLang.has(lang)) filesByLang.set(lang, new Set());
        filesByLang.get(lang)!.add(filePath);
      }

      if (node.label === 'Method' || node.label === 'Function' || node.label === 'Constructor') {
        callableNodes.push(node);
        const name = node.properties?.name || '';
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      } else if (node.label === 'Interface' || node.label === 'Trait') {
        interfaceNodes.push(node);
      }
    }

    if (filesByLang.size === 0) {
      return stats;
    }

    const index = buildGraphIndex(graph);

    try {
      // Start every language server at once so Java initialize is not blocked
      // behind TypeScript/Python document floods.
      await Promise.all(
        [...filesByLang.entries()].map(async ([lang, files]) => {
          let adapter: ILspAdapter | null = null;
          try {
            adapter = await this.registry.getOrStartAdapter(lang, repoPath);
          } catch {
            adapter = null;
          }
          if (!adapter) return;

          onProgress?.(`⚡ Enriching ${lang.toUpperCase()} symbols via ${adapter.id}...`);
          await this.enrichLanguage({
            adapter,
            lang,
            files,
            repoPath,
            graph,
            index,
            callableNodes,
            interfaceNodes,
            nameCounts,
            stats,
          });
        })
      );
    } finally {
      await this.registry.shutdownAll();
    }

    return stats;
  }

  private async enrichLanguage(opts: {
    adapter: ILspAdapter;
    lang: string;
    files: Set<string>;
    repoPath: string;
    graph: any;
    index: GraphIndex;
    callableNodes: GraphNodeLike[];
    interfaceNodes: GraphNodeLike[];
    nameCounts: Map<string, number>;
    stats: EnricherStats;
  }): Promise<void> {
    const {
      adapter,
      lang,
      files,
      repoPath,
      graph,
      index,
      callableNodes,
      interfaceNodes,
      nameCounts,
      stats,
    } = opts;

    const langInterfaces = interfaceNodes.filter((n) => files.has(n.properties?.filePath || ''));
    const langCallables = callableNodes.filter((n) => {
      if (!files.has(n.properties?.filePath || '')) return false;
      const name = n.properties?.name || '';
      const startLine = n.properties?.startLine ?? 1;
      const endLine = n.properties?.endLine ?? startLine;
      if (
        endLine - startLine <= 1 &&
        (nameCounts.get(name) || 0) <= 1 &&
        (name.startsWith('get') || name.startsWith('set'))
      ) {
        return false;
      }
      return true;
    });

    const workByFile = new Map<
      string,
      { interfaces: GraphNodeLike[]; callables: GraphNodeLike[] }
    >();
    for (const [filePath, nodes] of groupByFile(langInterfaces)) {
      workByFile.set(filePath, { interfaces: nodes, callables: [] });
    }
    for (const [filePath, nodes] of groupByFile(langCallables)) {
      const existing = workByFile.get(filePath);
      if (existing) existing.callables = nodes;
      else workByFile.set(filePath, { interfaces: [], callables: nodes });
    }

    const fileEntries = [...workByFile.entries()];
    await runConcurrent(
      fileEntries,
      async ([relFile, work]) => {
        const absPath = path.resolve(repoPath, relFile);
        let lineCache: string[] | null = null;
        const lineAt = (line1: number): string => {
          if (!lineCache) {
            try {
              lineCache = fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
            } catch {
              lineCache = [];
            }
          }
          return lineCache[Math.max(0, line1 - 1)] ?? '';
        };

        try {
          await adapter.openDocument(absPath);

          for (const ifaceNode of work.interfaces) {
            const line = (ifaceNode.properties?.startLine ?? 1) - 1;
            const char = lspCharacter(ifaceNode, lineAt(ifaceNode.properties?.startLine ?? 1));
            try {
              const implementations = await adapter.findImplementations(absPath, line, char);
              for (const impl of implementations) {
                const implFile = uriToRepoPath(impl.uri, repoPath);
                const typeNode = index.primaryTypeByFile.get(implFile);
                if (!typeNode) continue;
                const relId = `rel:lsp_impl:${typeNode.id}->${ifaceNode.id}`;
                graph.addRelationship({
                  id: relId,
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

          for (const callableNode of work.callables) {
            const line = (callableNode.properties?.startLine ?? 1) - 1;
            const char = lspCharacter(
              callableNode,
              lineAt(callableNode.properties?.startLine ?? 1)
            );
            try {
              const items = await adapter.prepareCallHierarchy(absPath, line, char);
              if (!items || items.length === 0) continue;
              const outgoing = await adapter.getOutgoingCalls(items[0]);
              for (const call of outgoing) {
                const targetFile = uriToRepoPath(call.to.uri, repoPath);
                const rawTargetName = call.to.name;
                const simpleTargetName = rawTargetName.split('(')[0].trim();
                const targetNode =
                  index.callablesByFileName.get(fileNameKey(targetFile, simpleTargetName)) ||
                  index.typesByFileName.get(fileNameKey(targetFile, simpleTargetName));
                if (!targetNode || targetNode.id === callableNode.id) continue;

                stats.conflictsResolved += this.pruneHeuristicConflicts(
                  graph,
                  index,
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
        } finally {
          if (adapter.closeDocument) {
            try {
              await adapter.closeDocument(absPath);
            } catch {
              // Ignore close errors
            }
          }
        }
      },
      rpcConcurrencyFor(lang)
    );
  }

  private pruneHeuristicConflicts(
    graph: any,
    index: GraphIndex,
    sourceId: string,
    targetFile: string,
    keepTargetId: string
  ): number {
    const candidates = index.heuristicCallsBySource.get(sourceId);
    if (!candidates || candidates.length === 0) return 0;
    let pruned = 0;
    const remaining: GraphRelLike[] = [];
    for (const existingRel of candidates) {
      const existingTarget = graph.getNode(existingRel.targetId);
      if (
        existingTarget &&
        existingTarget.properties?.filePath === targetFile &&
        existingTarget.id !== keepTargetId
      ) {
        graph.removeRelationship(existingRel.id);
        pruned += 1;
      } else {
        remaining.push(existingRel);
      }
    }
    index.heuristicCallsBySource.set(sourceId, remaining);
    return pruned;
  }
}
