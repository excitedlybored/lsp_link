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
import { ownerBuildRoot } from '../adapters/java/jdtls-runtime.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
  emptyCallHierarchy: number;
  unmappedCallTargets: number;
  javaBuildRoots: number;
  failedJavaBuildRoots: number;
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
      emptyCallHierarchy: 0,
      unmappedCallTargets: 0,
      javaBuildRoots: 0,
      failedJavaBuildRoots: 0,
    };

    const targets = collectEnrichmentTargets(graph, (filePath) =>
      this.registry.getLanguageForFile(filePath)
    );
    if (targets.filesByLanguage.size === 0) return stats;

    const index = GraphSymbolIndex.fromGraph(graph);

    try {
      await Promise.all(
        [...targets.filesByLanguage.entries()].map(async ([language, files]) => {
          if (language === 'java') {
            await this.enrichJavaBuildRoots(files, repoPath, graph, index, targets, stats, onProgress);
            return;
          }
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

  private async enrichJavaBuildRoots(
    files: Set<string>,
    repoPath: string,
    graph: KnowledgeGraph,
    index: GraphSymbolIndex,
    targets: EnrichmentTargets,
    stats: EnricherStats,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const roots = this.registry.getJavaBuildRoots(repoPath);
    const filesByRoot = new Map<string, { root: (typeof roots)[number]; files: Set<string> }>();
    for (const relFile of files) {
      const root = ownerBuildRoot(path.resolve(repoPath, relFile), roots);
      if (!root) continue;
      const group = filesByRoot.get(root.id) ?? { root, files: new Set<string>() };
      group.files.add(relFile);
      filesByRoot.set(root.id, group);
    }

    const bazelPreparation = await this.registry.prepareJavaBuildRoots(repoPath, [...filesByRoot.keys()]);
    if (bazelPreparation.roots.length > 0) {
      const ready = bazelPreparation.roots.filter((result) => result.status === 'generated' || result.status === 'cached').length;
      onProgress?.(`⚡ Prepared Bazel classpaths for ${ready}/${bazelPreparation.roots.length} Java roots (${bazelPreparation.concurrency} concurrent)`);
    }

    for (const { root, files: rootFiles } of [...filesByRoot.values()].sort((a, b) => a.root.id.localeCompare(b.root.id))) {
      const adapter = await this.registry.getOrStartJavaBuildRoot(root);
      if (!adapter) {
        stats.failedJavaBuildRoots += 1;
        continue;
      }
      stats.javaBuildRoots += 1;
      onProgress?.(`⚡ Enriching JAVA build root ${root.id} (${rootFiles.size} files)...`);
      try {
        await this.enrichLanguage(adapter, rootFiles, repoPath, graph, index, targets, stats);
      } finally {
        // Bound memory in large monorepos: one JDT process per build root, sequentially.
        await this.registry.shutdownAdapter(adapter);
      }
    }
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
    const pos = lspPositionForSymbol(ifaceNode, lineAt);
    try {
      const implementations = await adapter.findImplementations(absPath, pos.line0, pos.character);
      for (const impl of implementations) {
        const implFile = repoPathFromLspUri(impl.uri, repoPath);
        if (!implFile) continue;
        const typeNode = index.primaryTypeInFile(implFile);
        if (!typeNode) continue;
        graph.addRelationship({
          id: `rel:lsp_impl:${typeNode.id}->${ifaceNode.id}`,
          sourceId: typeNode.id,
          targetId: ifaceNode.id,
          type: 'IMPLEMENTS',
          confidence: 1.0,
          reason: `LSP: ${adapter.id} textDocument/implementation`,
          evidence: lspSessionEvidence(adapter),
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
    const pos = lspPositionForSymbol(callableNode, lineAt);
    try {
      const items = await adapter.prepareCallHierarchy(absPath, pos.line0, pos.character);
      if (!items || items.length === 0) {
        stats.emptyCallHierarchy += 1;
        return;
      }

      const outgoing = await adapter.getOutgoingCalls(items[0]);
      if (outgoing.length === 0) stats.emptyCallHierarchy += 1;
      for (const call of outgoing) {
        const targetFile = repoPathFromLspUri(call.to.uri, repoPath);
        const rawTargetName = call.to.name;
        const simpleTargetName = rawTargetName.split('(')[0].trim();
        if (!targetFile) {
          stats.unmappedCallTargets += 1;
          continue;
        }
        const targetNode = index.findCallableOrType(targetFile, simpleTargetName);
        if (!targetNode || targetNode.id === callableNode.id) {
          stats.unmappedCallTargets += 1;
          continue;
        }

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
          evidence: lspSessionEvidence(adapter),
        });
        stats.enrichedCalls += 1;
      }
    } catch {
      // Ignore individual callable lookup errors
    }
  }
}

function lspSessionEvidence(adapter: ILspAdapter): readonly { kind: string; weight: number; note?: string }[] {
  const session = adapter.getSessionMetadata();
  return [
    { kind: 'lsp-server', weight: 1, note: adapter.id },
    ...(session.buildRootId ? [{ kind: 'lsp-build-root', weight: 1, note: session.buildRootId }] : []),
    ...(session.buildSystems?.map((system) => ({ kind: 'lsp-build-system', weight: 1, note: system })) ?? []),
  ];
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

/**
 * Tree-sitter method spans often start on a blank line or annotation, not
 * the identifier. JDT prepareCallHierarchy needs the name token.
 */
function lspPositionForSymbol(
  node: GraphNode,
  lineAt: (line1: number) => string
): { line0: number; character: number } {
  const name = node.properties?.name || '';
  const startLine = Math.max(1, node.properties?.startLine ?? 1);
  const endLine = Math.max(startLine, node.properties?.endLine ?? startLine);
  if (name) {
    for (let line1 = startLine; line1 <= endLine; line1++) {
      const idx = lineAt(line1).indexOf(name);
      if (idx >= 0) return { line0: line1 - 1, character: idx };
    }
  }
  const named = node.properties?.startCol ?? node.properties?.column;
  const character = typeof named === 'number' && named >= 0 ? named : 0;
  return { line0: startLine - 1, character };
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

function repoPathFromLspUri(uri: string, repoPath: string): string | null {
  if (!uri.startsWith('file://')) return null;
  const abs = fileURLToPath(uri);
  const rel = path.relative(repoPath, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
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
