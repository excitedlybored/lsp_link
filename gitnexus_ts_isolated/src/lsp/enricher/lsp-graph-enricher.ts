/**
 * LSP Graph Enricher with Explicit Conflict Resolution.
 *
 * Traverses KnowledgeGraph nodes (Method, Class, Interface) and enriches them
 * with compiler-verified CALLS and IMPLEMENTS edges from LSP.
 *
 * Conflict Resolution Rule:
 * When LSP verifies an exact call target with 100% compiler precision,
 * any conflicting lower-confidence heuristic AST edges from the same call site
 * are pruned/overridden by the compiler ground truth.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
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

    const javaAdapter = await this.registry.getOrStartAdapter('java', repoPath);
    if (!javaAdapter) {
      return stats;
    }

    try {
      // 1. Enrich IMPLEMENTS from Interface declarations
      const interfaceNodes: any[] = [];
      for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
        if (node.label === 'Interface' && node.properties?.filePath?.endsWith('.java')) {
          interfaceNodes.push(node);
        }
      }

      onProgress?.(`Enriching ${interfaceNodes.length} Java interfaces via JDT.LS Implementations...`);

      for (const ifaceNode of interfaceNodes) {
        const filePath = path.resolve(repoPath, ifaceNode.properties.filePath);
        const line = (ifaceNode.properties.startLine ?? 1) - 1;
        const char = 10;

        try {
          const implementations = await javaAdapter.findImplementations(filePath, line, char);
          for (const impl of implementations) {
            const implFile = impl.uri.startsWith('file://')
              ? path.relative(repoPath, fileURLToPath(impl.uri))
              : impl.uri;

            for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
              if (
                node.label === 'Class' &&
                node.properties?.filePath === implFile
              ) {
                const relId = `rel:lsp_impl:${node.id}->${ifaceNode.id}`;
                graph.addRelationship({
                  id: relId,
                  sourceId: node.id,
                  targetId: ifaceNode.id,
                  type: 'IMPLEMENTS',
                  confidence: 1.0,
                  reason: 'LSP: JDT.LS textDocument/implementation',
                });
                stats.enrichedImplementations += 1;
              }
            }
          }
        } catch {
          // Ignore individual interface lookup errors
        }
      }

      // 2. Enrich CALLS from Method declarations & Resolve Conflicts
      const methodNodes: any[] = [];
      for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
        if (node.label === 'Method' && node.properties?.filePath?.endsWith('.java')) {
          methodNodes.push(node);
        }
      }

      onProgress?.(`Enriching ${methodNodes.length} Java methods via JDT.LS Call Hierarchy...`);

      for (const methodNode of methodNodes) {
        const filePath = path.resolve(repoPath, methodNode.properties.filePath);
        const line = (methodNode.properties.startLine ?? 1) - 1;
        const char = 15;

        try {
          const items = await javaAdapter.prepareCallHierarchy(filePath, line, char);
          if (items && items.length > 0) {
            const outgoing = await javaAdapter.getOutgoingCalls(items[0]);
            for (const call of outgoing) {
              const targetUri = call.to.uri;
              const targetFile = targetUri.startsWith('file://')
                ? path.relative(repoPath, fileURLToPath(targetUri))
                : targetUri;
              const rawTargetName = call.to.name; // e.g. "log(Order) : void"
              const simpleTargetName = rawTargetName.split('(')[0].trim();

              // Find exact matching method or class node in graph
              let targetNodeId: string | null = null;
              for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
                if (node.properties?.filePath === targetFile) {
                  if (
                    node.label === 'Method' &&
                    (node.properties?.name === simpleTargetName || rawTargetName.startsWith(node.properties?.name + '('))
                  ) {
                    targetNodeId = node.id;
                    break;
                  } else if (
                    node.label === 'Class' &&
                    node.properties?.name === simpleTargetName
                  ) {
                    targetNodeId = node.id;
                    break;
                  }
                }
              }

              if (targetNodeId && targetNodeId !== methodNode.id) {
                // Conflict Resolution: Prune conflicting heuristic AST edges from same caller
                if (graph.iterRelationships) {
                  for (const existingRel of graph.iterRelationships()) {
                    if (
                      existingRel.sourceId === methodNode.id &&
                      existingRel.type === 'CALLS' &&
                      existingRel.confidence < 1.0
                    ) {
                      const existingTarget = graph.getNode(existingRel.targetId);
                      // If AST previously guessed a different method in the same file/class, prune it
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
                const relId = `rel:lsp_call:${methodNode.id}->${targetNodeId}`;
                graph.addRelationship({
                  id: relId,
                  sourceId: methodNode.id,
                  targetId: targetNodeId,
                  type: 'CALLS',
                  confidence: 1.0,
                  reason: `LSP: JDT.LS Call Hierarchy (${rawTargetName})`,
                });
                stats.enrichedCalls += 1;
              }
            }
          }
        } catch {
          // Ignore individual method lookup errors
        }
      }
    } finally {
      await this.registry.shutdownAll();
    }

    return stats;
  }
}
