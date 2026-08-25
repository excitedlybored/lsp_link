import type { LspSymbolNodeTable } from '../../model.js';

export type LogicalInvocationStatus = 'resolved' | 'ambiguous' | 'unresolved';

export interface DerivedCallNormalizationRun {
  id: string;
  lspRunId: string;
  status: 'complete' | 'partial' | 'failed';
  algorithmVersion: string;
  startedAt: string;
  completedAt: string;
  observationCount: number;
  invocationCount: number;
  normalizedObservationCount: number;
  ambiguousObservationCount: number;
  errorCount: number;
}

export interface LspLogicalInvocation {
  id: string;
  stageId: string;
  runId: string;
  documentId: string;
  callerSymbolId: string;
  callerStableKey: string;
  targetFamilyId: string;
  targetFamilyStableKey: string;
  canonicalTargetId?: string;
  canonicalTargetKind?: LspSymbolNodeTable;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  observationCount: number;
  directions: string[];
  capabilities: string[];
  stableKey: string;
  status: LogicalInvocationStatus;
  confidence: number;
  algorithmVersion: string;
}

export interface DerivedCallRelation {
  id: string;
  sourceKind: 'DerivedCallNormalizationRun' | 'LspCallSite' | 'LspLogicalInvocation';
  sourceId: string;
  targetKind: 'LspLogicalInvocation' | LspSymbolNodeTable;
  targetId: string;
  kind: 'HAS_LOGICAL_INVOCATION' | 'NORMALIZES_TO' | 'LOGICAL_RESOLVES_TO';
  stageId: string;
  confidence: number;
  ordinal: number;
}

export interface DerivedCallNormalizationBatch {
  runs: DerivedCallNormalizationRun[];
  invocations: LspLogicalInvocation[];
  relations: DerivedCallRelation[];
}

export function emptyDerivedCallNormalizationBatch(): DerivedCallNormalizationBatch {
  return { runs: [], invocations: [], relations: [] };
}
