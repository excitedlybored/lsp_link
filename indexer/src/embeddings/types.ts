/** Minimal types the Ladybug adapter and hybrid search import. */

export const EMBEDDABLE_LABELS = [
  'Function',
  'Class',
  'Interface',
  'Method',
  'Constructor',
  'Struct',
  'Enum',
  'Trait',
  'Impl',
  'Macro',
  'Namespace',
  'TypeAlias',
  'Typedef',
  'Const',
  'Property',
  'Record',
  'Delegate',
  'Union',
  'Static',
  'Variable',
  'CodeElement',
] as const;

export type EmbeddableLabel = (typeof EMBEDDABLE_LABELS)[number];

export interface CachedEmbedding {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  contentHash?: string;
}

export interface SemanticSearchResult {
  nodeId: string;
  name?: string;
  filePath: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  score: number;
}
