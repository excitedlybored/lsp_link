/**
 * LSP Graph Enricher.
 *
 * Traverses KnowledgeGraph nodes (Method, Class, Interface) and enriches them
 * with compiler-verified CALLS and IMPLEMENTS edges from LSP.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';

export interface EnricherStats {
  enrichedCalls: number;
  enrichedImplementations: number;
  enrichedTypes: number;
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
      enrichedTypes: 0,
    };

    const javaAdapter = await this.registry.getOrStartAdapter('java', repoPath);
    if (!javaAdapter) {
      return stats;
    }

    try {
      // 1. Enrich CALLS from Method declarations
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
              const targetName = call.to.name;

              // Find matching node in graph
              let targetNodeId: string | null = null;
              for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
                if (
                  node.properties?.filePath === targetFile &&
                  node.properties?.name === targetName
                ) {
                  targetNodeId = node.id;
                  break;
                }
              }

              if (targetNodeId && targetNodeId !== methodNode.id) {
                const relId = `rel:lsp_call:${methodNode.id}->${targetNodeId}`;
                graph.addRelationship({
                  id: relId,
                  sourceId: methodNode.id,
                  targetId: targetNodeId,
                  type: 'CALLS',
                  confidence: 1.0,
                  reason: 'LSP: JDT.LS Compiler Call Hierarchy',
                });
                stats.enrichedCalls += 1;
              }
            }
          }
        } catch {
          // Ignore individual method lookup errors
        }
      }

      // 2. Enrich IMPLEMENTS from Interface declarations
      const interfaceNodes: any[] = [];
      for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
        if (node.label === 'Interface' && node.properties?.filePath?.endsWith('.java')) {
          interfaceNodes.push(node);
        }
      }

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
    } finally {
      await this.registry.shutdownAll();
    }

    return stats;
  }
}
