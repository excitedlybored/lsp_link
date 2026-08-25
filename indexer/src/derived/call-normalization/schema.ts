import { LSP_SYMBOL_NODE_TABLES } from '../../model.js';

const LOGICAL_TARGET_ENDPOINTS = LSP_SYMBOL_NODE_TABLES
  .map((table) => `    FROM LspLogicalInvocation TO ${table}`)
  .join(',\n');

export const DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES = [
  `CREATE NODE TABLE DerivedCallNormalizationRun (
    id STRING, lspRunId STRING, status STRING, algorithmVersion STRING,
    startedAt STRING, completedAt STRING, observationCount INT64,
    invocationCount INT64, normalizedObservationCount INT64,
    ambiguousObservationCount INT64, errorCount INT64, PRIMARY KEY (id))`,
  `CREATE NODE TABLE LspLogicalInvocation (
    id STRING, stageId STRING, runId STRING, documentId STRING,
    callerSymbolId STRING, callerStableKey STRING, targetFamilyId STRING,
    targetFamilyStableKey STRING, canonicalTargetId STRING,
    canonicalTargetKind STRING, startLine INT64, startCharacter INT64,
    endLine INT64, endCharacter INT64, observationCount INT64,
    directions STRING[], capabilities STRING[], stableKey STRING,
    status STRING, confidence DOUBLE, algorithmVersion STRING, PRIMARY KEY (id))`,
  `CREATE REL TABLE DerivedCallRelation (
    FROM DerivedCallNormalizationRun TO LspLogicalInvocation,
    FROM LspCallSite TO LspLogicalInvocation,
${LOGICAL_TARGET_ENDPOINTS},
    id STRING, kind STRING, stageId STRING, confidence DOUBLE, ordinal INT32)`,
] as const;
