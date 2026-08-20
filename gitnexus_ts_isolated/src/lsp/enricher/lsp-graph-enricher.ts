/**
 * Polyglot LSP Graph Enricher with High-Throughput Concurrent Batching,
 * Automatic Fallback, and Active Conflict Resolution.
 *
 * Performance Optimizations:
 * - Pre-opens all documents in parallel upfront.
 * - Concurrently dispatches call hierarchy & implementation queries across a worker pool.
 * - Zero artificial sleep delays.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';
import { ILspAdapter } from '../contracts/lsp-adapter.interface.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
}

/**
 * Executes async tasks with a maximum concurrency limit.
 */
async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency = 10
): Promise<void> {
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p: Promise<void> = Promise.resolve().then(() => fn(item));
    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
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

    // 1. Collect all callable and interface nodes in the graph
    const callableNodes: any[] = [];
    const interfaceNodes: any[] = [];
    const filesByLang = new Map<string, Set<string>>();

    for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
      const filePath = node.properties?.filePath;
      if (!filePath) continue;

      const lang = this.registry.getLanguageForFile(filePath);
      if (lang) {
        if (!filesByLang.has(lang)) filesByLang.set(lang, new Set());
        filesByLang.get(lang)!.add(filePath);
      }

      if (node.label === 'Method' || node.label === 'Function') {
        callableNodes.push(node);
      } else if (node.label === 'Interface' || node.label === 'Trait') {
        interfaceNodes.push(node);
      }
    }

    if (filesByLang.size === 0) {
      return stats;
    }

    try {
      // 2. Process each language found in the repository
      for (const [lang, files] of filesByLang.entries()) {
        let adapter: ILspAdapter | null = null;
        try {
          adapter = await this.registry.getOrStartAdapter(lang, repoPath);
        } catch {
          // Graceful fallback if language server is unavailable
        }

        if (!adapter) {
          continue;
        }

        onProgress?.(`⚡ Enriching ${lang.toUpperCase()} symbols via ${adapter.id}...`);

        // A. Pre-open all files in parallel upfront
        const absFilePaths = Array.from(files).map((f) => path.resolve(repoPath, f));
        await runConcurrent(absFilePaths, async (absPath) => {
          await adapter!.openDocument(absPath);
        }, 12);

        // B. Enrich IMPLEMENTS concurrently
        const langInterfaces = interfaceNodes.filter((n) =>
          files.has(n.properties?.filePath)
        );

        await runConcurrent(
          langInterfaces,
          async (ifaceNode) => {
            const filePath = path.resolve(repoPath, ifaceNode.properties.filePath);
            const line = (ifaceNode.properties.startLine ?? 1) - 1;
            const char = 10;

            try {
              const implementations = await adapter!.findImplementations(filePath, line, char);
              for (const impl of implementations) {
                const implFile = impl.uri.startsWith('file://')
                  ? path.relative(repoPath, fileURLToPath(impl.uri))
                  : impl.uri;

                for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
                  if (
                    (node.label === 'Class' || node.label === 'Struct') &&
                    node.properties?.filePath === implFile
                  ) {
                    const relId = `rel:lsp_impl:${node.id}->${ifaceNode.id}`;
                    graph.addRelationship({
                      id: relId,
                      sourceId: node.id,
                      targetId: ifaceNode.id,
                      type: 'IMPLEMENTS',
                      confidence: 1.0,
                      reason: `LSP: ${adapter!.id} textDocument/implementation`,
                    });
                    stats.enrichedImplementations += 1;
                  }
                }
              }
            } catch {
              // Ignore individual interface lookup errors
            }
          },
          8
        );

        // C. Enrich CALLS concurrently with conflict resolution
        const nameCounts = new Map<string, number>();
        for (const n of callableNodes) {
          const name = n.properties?.name || '';
          nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
        }

        const langCallables = callableNodes.filter((n) => {
          if (!files.has(n.properties?.filePath)) return false;
          const name = n.properties?.name || '';
          const startLine = n.properties?.startLine ?? 1;
          const endLine = n.properties?.endLine ?? startLine;
          // Skip trivial 1-line getters / setters unless overloaded
          if (endLine - startLine <= 1 && (nameCounts.get(name) || 0) <= 1 && (name.startsWith('get') || name.startsWith('set'))) {
            return false;
          }
          return true;
        });

        await runConcurrent(
          langCallables,
          async (callableNode) => {
            const filePath = path.resolve(repoPath, callableNode.properties.filePath);
            const line = (callableNode.properties.startLine ?? 1) - 1;
            const char = 15;

            try {
              const items = await adapter!.prepareCallHierarchy(filePath, line, char);
              if (items && items.length > 0) {
                const outgoing = await adapter!.getOutgoingCalls(items[0]);
                for (const call of outgoing) {
                  const targetUri = call.to.uri;
                  const targetFile = targetUri.startsWith('file://')
                    ? path.relative(repoPath, fileURLToPath(targetUri))
                    : targetUri;
                  const rawTargetName = call.to.name;
                  const simpleTargetName = rawTargetName.split('(')[0].trim();

                  // Find matching method, function, struct, or class node in graph
                  let targetNodeId: string | null = null;
                  for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
                    if (node.properties?.filePath === targetFile) {
                      if (
                        (node.label === 'Method' || node.label === 'Function') &&
                        (node.properties?.name === simpleTargetName || rawTargetName.startsWith(node.properties?.name + '('))
                      ) {
                        targetNodeId = node.id;
                        break;
                      } else if (
                        (node.label === 'Class' || node.label === 'Struct') &&
                        node.properties?.name === simpleTargetName
                      ) {
                        targetNodeId = node.id;
                        break;
                      }
                    }
                  }

                  if (targetNodeId && targetNodeId !== callableNode.id) {
                    // Conflict Resolution: Prune conflicting heuristic AST edges from same caller
                    if (graph.iterRelationships) {
                      for (const existingRel of graph.iterRelationships()) {
                        if (
                          existingRel.sourceId === callableNode.id &&
                          existingRel.type === 'CALLS' &&
                          existingRel.confidence < 1.0
                        ) {
                          const existingTarget = graph.getNode(existingRel.targetId);
                          if (
                            existingTarget &&
                            existingTarget.properties?.filePath === targetFile &&
                            existingTarget.id !== targetNodeId
                          ) {
                            graph.removeRelationship(existingRel.id);
                            stats.conflictsResolved += 1;
                          }
                        }
                      }
                    }

                    // Injected Compiler-Verified Edge
                    const relId = `rel:lsp_call:${callableNode.id}->${targetNodeId}`;
                    graph.addRelationship({
                      id: relId,
                      sourceId: callableNode.id,
                      targetId: targetNodeId,
                      type: 'CALLS',
                      confidence: 1.0,
                      reason: `LSP: ${adapter!.id} Call Hierarchy (${rawTargetName})`,
                    });
                    stats.enrichedCalls += 1;
                  }
                }
              }
            } catch {
              // Ignore individual callable lookup errors
            }
          },
          12
        );
      }
    } finally {
      await this.registry.shutdownAll();
    }

    return stats;
  }
}
