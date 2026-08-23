/**
 * Load / save the `.gitnexus/graph.json` export used to hand a Tree-sitter
 * graph to an isolated LSP sub-pipeline (and back).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from 'gitnexus-shared';
import { createKnowledgeGraph } from './graph.js';
import type { KnowledgeGraph } from './types.js';

export const GRAPH_JSON_FILENAME = 'graph.json';

export interface GraphJsonStats {
  files: number;
  nodes: number;
  edges: number;
  communities: number;
  processes: number;
}

export interface GraphJsonDocument {
  repoPath: string;
  indexedAt: string;
  lspEnriched: boolean;
  pipelineStage?: 'full' | 'treesitter' | 'lsp';
  stats: GraphJsonStats;
  nodes: Array<{
    id: string;
    label: string;
    properties: GraphNode['properties'];
  }>;
  relationships: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    confidence?: number;
    reason?: string;
    step?: number;
    evidence?: GraphRelationship['evidence'];
  }>;
}

export function graphJsonPath(repoPath: string): string {
  return path.join(repoPath, '.gitnexus', GRAPH_JSON_FILENAME);
}

export function knowledgeGraphFromJsonDocument(doc: GraphJsonDocument): KnowledgeGraph {
  const graph = createKnowledgeGraph();
  for (const node of doc.nodes) {
    graph.addNode({
      id: node.id,
      label: node.label as NodeLabel,
      properties: node.properties,
    });
  }
  for (const rel of doc.relationships) {
    graph.addRelationship({
      id: rel.id,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      type: rel.type as RelationshipType,
      confidence: rel.confidence ?? 1.0,
      reason: rel.reason || '',
      ...(rel.step !== undefined ? { step: rel.step } : {}),
      ...(rel.evidence !== undefined ? { evidence: rel.evidence } : {}),
    });
  }
  return graph;
}

export function graphToJsonDocument(
  graph: KnowledgeGraph,
  fields: {
    repoPath: string;
    indexedAt: string;
    lspEnriched: boolean;
    pipelineStage: 'full' | 'treesitter' | 'lsp';
    stats: GraphJsonStats;
  },
): GraphJsonDocument {
  const nodes: GraphJsonDocument['nodes'] = [];
  for (const node of graph.iterNodes()) {
    nodes.push({
      id: node.id,
      label: node.label,
      properties: node.properties || ({} as GraphNode['properties']),
    });
  }

  const relationships: GraphJsonDocument['relationships'] = [];
  for (const rel of graph.iterRelationships()) {
    relationships.push({
      id: rel.id,
      sourceId: rel.sourceId,
      targetId: rel.targetId,
      type: rel.type,
      confidence: rel.confidence ?? 1.0,
      reason: rel.reason || '',
      ...(rel.step !== undefined ? { step: rel.step } : {}),
      ...(rel.evidence !== undefined ? { evidence: rel.evidence } : {}),
    });
  }

  return {
    repoPath: fields.repoPath,
    indexedAt: fields.indexedAt,
    lspEnriched: fields.lspEnriched,
    pipelineStage: fields.pipelineStage,
    stats: fields.stats,
    nodes,
    relationships,
  };
}

export function readGraphJson(repoPath: string): GraphJsonDocument {
  const filePath = graphJsonPath(repoPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No saved graph at ${filePath}. Run the treesitter pipeline first:\n` +
        `  npm run analyze:treesitter -- ${repoPath}`,
    );
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const doc = JSON.parse(raw) as GraphJsonDocument;
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.relationships)) {
    throw new Error(`Invalid graph export at ${filePath}: missing nodes or relationships arrays.`);
  }
  return doc;
}

export function writeGraphJson(repoPath: string, doc: GraphJsonDocument): void {
  const gitnexusDir = path.join(repoPath, '.gitnexus');
  fs.mkdirSync(gitnexusDir, { recursive: true });
  fs.writeFileSync(graphJsonPath(repoPath), JSON.stringify(doc, null, 2), 'utf-8');
}
