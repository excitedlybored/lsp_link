/**
 * O(1) lookups from knowledge-graph nodes to LSP results.
 *
 * Built in one pass over nodes and heuristic CALLS. Matching a compiler
 * location is then a map get, not a scan of every symbol.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../graph/types.js';

const CALLABLE_LABELS = new Set(['Method', 'Function', 'Constructor']);
const TYPE_LABELS = new Set(['Class', 'Struct', 'Interface', 'Trait']);
const PRIMARY_TYPE_LABELS = new Set(['Class', 'Struct']);

function fileNameKey(filePath: string, name: string): string {
  return `${filePath}\0${name}`;
}

export class GraphSymbolIndex {
  private readonly callablesByFileName = new Map<string, GraphNode>();
  private readonly typesByFileName = new Map<string, GraphNode>();
  private readonly primaryTypeByFile = new Map<string, GraphNode>();
  private readonly heuristicCallsBySource = new Map<string, GraphRelationship[]>();

  static fromGraph(graph: KnowledgeGraph): GraphSymbolIndex {
    const index = new GraphSymbolIndex();
    index.indexNodes(graph);
    index.indexHeuristicCalls(graph);
    return index;
  }

  findCallable(filePath: string, name: string): GraphNode | undefined {
    return this.callablesByFileName.get(fileNameKey(filePath, name));
  }

  findType(filePath: string, name: string): GraphNode | undefined {
    return this.typesByFileName.get(fileNameKey(filePath, name));
  }

  findCallableOrType(filePath: string, name: string): GraphNode | undefined {
    return this.findCallable(filePath, name) ?? this.findType(filePath, name);
  }

  primaryTypeInFile(filePath: string): GraphNode | undefined {
    return this.primaryTypeByFile.get(filePath);
  }

  /**
   * Drops heuristic CALLS from `sourceId` into the same file as the
   * compiler-resolved target (wrong overloads, and the 0.85 edge being upgraded).
   */
  dropConflictingHeuristicCalls(
    graph: KnowledgeGraph,
    sourceId: string,
    targetFile: string,
    keepTargetId: string
  ): number {
    const candidates = this.heuristicCallsBySource.get(sourceId);
    if (!candidates || candidates.length === 0) return 0;

    let dropped = 0;
    const remaining: GraphRelationship[] = [];
    for (const existing of candidates) {
      const existingTarget = graph.getNode(existing.targetId);
      if (existingTarget && existingTarget.properties.filePath === targetFile) {
        graph.removeRelationship(existing.id);
        dropped += 1;
      } else {
        remaining.push(existing);
      }
    }
    this.heuristicCallsBySource.set(sourceId, remaining);
    return dropped;
  }

  private indexNodes(graph: KnowledgeGraph): void {
    for (const node of graph.iterNodes()) {
      const filePath = node.properties.filePath;
      const name = node.properties.name;
      if (!filePath || !name) continue;
      const key = fileNameKey(filePath, name);

      if (CALLABLE_LABELS.has(node.label)) {
        if (!this.callablesByFileName.has(key)) this.callablesByFileName.set(key, node);
        continue;
      }

      if (!TYPE_LABELS.has(node.label)) continue;
      if (!this.typesByFileName.has(key)) this.typesByFileName.set(key, node);
      if (PRIMARY_TYPE_LABELS.has(node.label) && !this.primaryTypeByFile.has(filePath)) {
        this.primaryTypeByFile.set(filePath, node);
      }
    }
  }

  private indexHeuristicCalls(graph: KnowledgeGraph): void {
    const calls = graph.iterRelationshipsByType
      ? graph.iterRelationshipsByType('CALLS')
      : graph.iterRelationships();
    for (const rel of calls) {
      if (rel.type !== 'CALLS') continue;
      if (rel.confidence >= 1.0) continue;
      let bucket = this.heuristicCallsBySource.get(rel.sourceId);
      if (!bucket) {
        bucket = [];
        this.heuristicCallsBySource.set(rel.sourceId, bucket);
      }
      bucket.push(rel);
    }
  }
}
