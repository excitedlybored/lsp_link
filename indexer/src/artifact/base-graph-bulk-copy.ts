import fs from 'node:fs';
import path from 'node:path';

import type { BazelBuildGraphBatch, BazelRelation } from '../bazel/model.js';
import type { DerivedCallNormalizationBatch, DerivedCallRelation } from '../derived/call-normalization/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import type { LspRelation, LspSymbolNodeTable } from '../model.js';
import type { RepositoryInventoryBatch } from '../repository/model.js';
import {
  toAnalysisRunRow,
  toBuildRootRow,
  toCallSiteRow,
  toCoverageRow,
  toDiagnosticRow,
  toDocumentRow,
  toHoverRow,
  toOccurrenceRow,
  toParameterRow,
  toRelationRow,
  toSemanticTokenRow,
  toServerRow,
  toSignatureHelpRow,
  toSignatureRow,
  toSymbolRecord,
} from '../lbug/rows.js';
import type { LbugConnectionLike } from '../lbug/repository.js';
import {
  BulkCsvFiles,
  copyNodeCsvFragments,
  copyRelationCsvFragments,
  updateArrayProperties,
} from './bulk-copy-support.js';
import { withMemoryTelemetry } from '../telemetry/memory.js';

const BASE_COPY_ROWS_PER_CHUNK = positiveInteger(
  process.env.GITNEXUS_LBUG_BASE_ROWS_PER_CHUNK, 100_000,
  'GITNEXUS_LBUG_BASE_ROWS_PER_CHUNK',
);

interface NodeSpec {
  key: string;
  table: string;
  columns: readonly string[];
  rows: Array<Record<string, unknown>>;
}

interface RelationSpec {
  key: string;
  table: string;
  from: string;
  to: string;
  columns: readonly string[];
  rows: Array<Record<string, unknown>>;
}

/** Bulk-persist every non-JVM graph family into an already initialized schema. */
export async function bulkCopyBaseGraph(
  connection: LbugConnectionLike,
  workDirectory: string,
  lsp: LspObservationBatch,
  calls: DerivedCallNormalizationBatch,
  bazel: BazelBuildGraphBatch,
  inventory: RepositoryInventoryBatch,
): Promise<void> {
  fs.rmSync(workDirectory, { recursive: true, force: true });
  fs.mkdirSync(workDirectory, { recursive: true });
  const symbolsByTable = new Map<LspSymbolNodeTable, Array<Record<string, unknown>>>();
  for (const symbol of lsp.symbols) {
    const record = toSymbolRecord(symbol);
    const rows = symbolsByTable.get(record.table) ?? [];
    rows.push(record.row as unknown as Record<string, unknown>);
    symbolsByTable.set(record.table, rows);
  }

  const nodes: NodeSpec[] = [
    node('LspAnalysisRun', LSP_ANALYSIS_RUN_COLUMNS, lsp.analysisRuns.map(toAnalysisRunRow)),
    node('LspBuildRoot', LSP_BUILD_ROOT_COLUMNS, lsp.buildRoots.map(toBuildRootRow)),
    node('LspServer', LSP_SERVER_COLUMNS, lsp.servers.map(toServerRow)),
    node('LspDocument', LSP_DOCUMENT_COLUMNS, lsp.documents.map(toDocumentRow)),
    ...[...symbolsByTable].map(([table, rows]) => node(table, LSP_SYMBOL_COLUMNS, rows)),
    node('LspCallSite', LSP_CALL_SITE_COLUMNS, lsp.callSites.map(toCallSiteRow)),
    node('LspOccurrence', LSP_OCCURRENCE_COLUMNS, lsp.occurrences.map(toOccurrenceRow)),
    node('LspDiagnostic', LSP_DIAGNOSTIC_COLUMNS, lsp.diagnostics.map(toDiagnosticRow)),
    node('LspCoverage', LSP_COVERAGE_COLUMNS, lsp.coverage.map(toCoverageRow)),
    node('LspHover', LSP_HOVER_COLUMNS, lsp.hovers.map(toHoverRow)),
    node('LspSemanticToken', LSP_SEMANTIC_TOKEN_COLUMNS, lsp.semanticTokens.map(toSemanticTokenRow)),
    node('LspSignatureHelp', LSP_SIGNATURE_HELP_COLUMNS, lsp.signatureHelps.map(toSignatureHelpRow)),
    node('LspSignature', LSP_SIGNATURE_COLUMNS, lsp.signatures.map(toSignatureRow)),
    node('LspParameter', LSP_PARAMETER_COLUMNS, lsp.parameters.map(toParameterRow)),
    node('DerivedCallNormalizationRun', DERIVED_RUN_COLUMNS, calls.runs),
    node('LspLogicalInvocation', LOGICAL_INVOCATION_COLUMNS, calls.invocations.map((value) => ({
      ...value,
      canonicalTargetId: value.canonicalTargetId ?? null,
      canonicalTargetKind: value.canonicalTargetKind ?? null,
    }))),
    node('BazelBuildGraphRun', BAZEL_RUN_COLUMNS, bazel.runs.map((value) => ({
      ...value,
      configurationHash: value.configurationHash ?? null,
      scopeConfigHash: value.scopeConfigHash ?? null,
      scopeSelectorsJson: value.scopeSelectorsJson ?? null,
    }))),
    node('BazelTarget', BAZEL_TARGET_COLUMNS, bazel.targets.map((value) => ({
      ...value, ruleKind: value.ruleKind ?? null,
    }))),
    node('BazelSource', BAZEL_SOURCE_COLUMNS, bazel.sources),
    node('BazelArtifact', BAZEL_ARTIFACT_COLUMNS, bazel.artifacts),
    node('RepositoryInventoryRun', REPOSITORY_RUN_COLUMNS, inventory.runs),
    node('RepositoryProviderRun', REPOSITORY_PROVIDER_COLUMNS, inventory.providers),
    node('RepositoryDocument', REPOSITORY_DOCUMENT_COLUMNS, inventory.documents),
    node('RepositoryDeclaration', REPOSITORY_DECLARATION_COLUMNS, inventory.declarations),
  ];
  const relations = [
    ...groupLspRelations(lsp.relations),
    ...groupDerivedRelations(calls.relations),
    ...groupBazelRelations(bazel.relations),
    ...repositoryRelations(inventory),
  ];

  try {
    for (const spec of nodes) {
      const chunks = chunked(spec.rows, BASE_COPY_ROWS_PER_CHUNK);
      for (const [chunkIndex, rows] of chunks.entries()) {
        const csv = await generateBaseCsvChunk(
          workDirectory, `${spec.key}-${chunkIndex}`, spec.table, chunkIndex, chunks.length,
          (output) => { for (const row of rows) output.object(spec.key, row, spec.columns); },
        );
        try {
          await withMemoryTelemetry('node-copying', () => copyNodeCsvFragments(
              connection, csv, spec.key, spec.table, spec.columns,
            ), { graph: 'base', table: spec.table, chunk: chunkIndex + 1, chunks: chunks.length });
        } finally {
          csv.remove();
        }
        reportBaseProgress('node-copying', spec.table, chunkIndex, chunks.length, rows.length);
      }
    }
    await applyArrayProperties(connection, lsp, calls, inventory, symbolsByTable);

    for (const spec of relations) {
      const chunks = chunked(spec.rows, BASE_COPY_ROWS_PER_CHUNK);
      for (const [chunkIndex, rows] of chunks.entries()) {
        const csv = await generateBaseCsvChunk(
          workDirectory, `${spec.key}-${chunkIndex}`, `${spec.from}->${spec.to}`,
          chunkIndex, chunks.length,
          (output) => { for (const row of rows) output.object(spec.key, row, spec.columns); },
        );
        try {
          await withMemoryTelemetry('relationship-copying', () => copyRelationCsvFragments(
              connection, csv, spec.key, spec.table, spec.columns, spec.from, spec.to,
            ), {
              graph: 'base', table: spec.table, from: spec.from, to: spec.to,
              chunk: chunkIndex + 1, chunks: chunks.length,
            });
        } finally {
          csv.remove();
        }
        reportBaseProgress(
          'relationship-copying', `${spec.from}->${spec.to}`,
          chunkIndex, chunks.length, rows.length,
        );
      }
    }
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

async function generateBaseCsvChunk(
  workDirectory: string,
  name: string,
  table: string,
  chunkIndex: number,
  chunkCount: number,
  write: (csv: BulkCsvFiles) => void,
): Promise<BulkCsvFiles> {
  const csv = new BulkCsvFiles(path.join(workDirectory, name));
  fs.mkdirSync(csv.directory, { recursive: true });
  try {
    await withMemoryTelemetry('csv-generation', async () => {
      write(csv);
      csv.close();
    }, { graph: 'base', table, chunk: chunkIndex + 1, chunks: chunkCount });
    return csv;
  } catch (error) {
    csv.remove();
    throw error;
  }
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function reportBaseProgress(
  stage: string,
  table: string,
  index: number,
  total: number,
  rows: number,
): void {
  const completed = index + 1;
  if (completed === total || completed === 1 || completed % 10 === 0) {
    const percent = total === 0 ? 100 : Math.floor(completed / total * 100);
    console.log(`[stage:${stage}] ${table} ${completed}/${total} chunks (${percent}%); chunkRows=${rows}`);
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}

function node<T extends object>(
  table: string,
  columns: readonly string[],
  rows: T[],
): NodeSpec {
  return { key: `node-${table}`, table, columns, rows: rows as Array<Record<string, unknown>> };
}

function groupLspRelations(values: LspRelation[]): RelationSpec[] {
  return groupRelations('LspRelation', LSP_RELATION_COLUMNS, values.map((value) => ({
    from: value.sourceKind,
    to: value.targetKind,
    row: toRelationRow(value) as unknown as Record<string, unknown>,
  })));
}

function groupDerivedRelations(values: DerivedCallRelation[]): RelationSpec[] {
  return groupRelations('DerivedCallRelation', DERIVED_RELATION_COLUMNS, values.map((value) => ({
    from: value.sourceKind,
    to: value.targetKind,
    row: {
      from: value.sourceId, to: value.targetId, id: value.id, kind: value.kind,
      stageId: value.stageId, confidence: value.confidence, ordinal: value.ordinal,
    },
  })));
}

function groupBazelRelations(values: BazelRelation[]): RelationSpec[] {
  return groupRelations('BazelRelation', BAZEL_RELATION_COLUMNS, values.map((value) => ({
    from: value.sourceKind,
    to: value.targetKind,
    row: {
      from: value.sourceId, to: value.targetId, id: value.id, graphId: value.graphId,
      kind: value.kind, attribute: value.attribute ?? null, ordinal: value.ordinal,
    },
  })));
}

function repositoryRelations(batch: RepositoryInventoryBatch): RelationSpec[] {
  const providerRuns = new Map(batch.providers.map((value) => [value.providerId, value.id]));
  return groupRelations('RepositoryInventoryRelation', REPOSITORY_RELATION_COLUMNS, [
    ...batch.providers.map((value) => ({
      from: 'RepositoryInventoryRun', to: 'RepositoryProviderRun',
      row: { from: value.runId, to: value.id, kind: 'USED_PROVIDER' },
    })),
    ...batch.documents.map((value) => {
      const providerRunId = providerRuns.get(value.providerId);
      if (!providerRunId) throw new Error(`Repository document has no provider run: ${value.providerId}`);
      return {
        from: 'RepositoryProviderRun', to: 'RepositoryDocument',
        row: { from: providerRunId, to: value.id, kind: 'INDEXED_DOCUMENT' },
      };
    }),
    ...batch.documents.map((value) => ({
      from: 'RepositoryInventoryRun', to: 'RepositoryDocument',
      row: { from: value.runId, to: value.id, kind: 'CONTAINS_DOCUMENT' },
    })),
    ...batch.declarations.map((value) => ({
      from: 'RepositoryDocument', to: 'RepositoryDeclaration',
      row: { from: value.documentId, to: value.id, kind: 'DECLARES' },
    })),
  ]);
}

function groupRelations(
  table: string,
  columns: readonly string[],
  values: Array<{ from: string; to: string; row: Record<string, unknown> }>,
): RelationSpec[] {
  const groups = new Map<string, RelationSpec>();
  for (const value of values) {
    const key = `relation-${table}-${value.from}-${value.to}`;
    const current = groups.get(key) ?? {
      key, table, from: value.from, to: value.to, columns, rows: [],
    };
    current.rows.push(value.row);
    groups.set(key, current);
  }
  return [...groups.values()];
}

async function applyArrayProperties(
  connection: LbugConnectionLike,
  lsp: LspObservationBatch,
  calls: DerivedCallNormalizationBatch,
  inventory: RepositoryInventoryBatch,
  symbolsByTable: Map<LspSymbolNodeTable, Array<Record<string, unknown>>>,
): Promise<void> {
  await updateArrayProperties(connection, 'LspAnalysisRun', lsp.analysisRuns.map((value) => ({
    id: value.id, requestedLanguages: value.requestedLanguages,
  })), ['requestedLanguages']);
  await updateArrayProperties(connection, 'LspBuildRoot', lsp.buildRoots.map((value) => ({
    id: value.id, buildSystems: value.buildSystems, excludedRootIds: value.excludedRootIds,
  })), ['buildSystems', 'excludedRootIds']);
  for (const [table, rows] of symbolsByTable) {
    await updateArrayProperties(connection, table, rows.map((value) => ({
      id: value.id, tags: value.tags,
    })), ['tags'], { tags: 'INT32[]' });
  }
  await updateArrayProperties(connection, 'LspDiagnostic', lsp.diagnostics.map((value) => ({
    id: value.id, tags: value.tags,
  })), ['tags'], { tags: 'INT32[]' });
  await updateArrayProperties(connection, 'LspSemanticToken', lsp.semanticTokens.map((value) => ({
    id: value.id, tokenModifiers: value.tokenModifiers,
  })), ['tokenModifiers']);
  await updateArrayProperties(connection, 'LspLogicalInvocation', calls.invocations.map((value) => ({
    id: value.id, directions: value.directions, capabilities: value.capabilities,
  })), ['directions', 'capabilities']);
  await updateArrayProperties(connection, 'RepositoryProviderRun', inventory.providers.map((value) => ({
    id: value.id, languages: value.languages, capabilities: value.capabilities,
    includeGlobs: value.includeGlobs,
  })), ['languages', 'capabilities', 'includeGlobs']);
}

const LSP_ANALYSIS_RUN_COLUMNS = ['id','workspaceUri','repositoryPath','protocolVersion','positionEncoding','status','startedAt','completedAt','configurationHash','errorCount','timeoutCount'];
const LSP_BUILD_ROOT_COLUMNS = ['id','runId','workspaceUri','repositoryPath','relativePath','javaMajor','importStatus','configurationHash'];
const LSP_SERVER_COLUMNS = ['id','runId','name','version','languageId','command','status','capabilitiesJson','observationsJson','buildRootId','processShardId'];
const LSP_DOCUMENT_COLUMNS = ['id','uri','filePath','languageId','version','contentHash','origin','codeOrigin','wasOpened','buildRootId'];
const LSP_SYMBOL_COLUMNS = ['id','documentId','uri','name','detail','kind','kindName','containerName','startLine','startCharacter','endLine','endCharacter','selectionStartLine','selectionStartCharacter','selectionEndLine','selectionEndCharacter','signature','stableKey','isExternal','codeOrigin'];
const LSP_CALL_SITE_COLUMNS = ['id','runId','serverId','documentId','callerSymbolId','capability','direction','startLine','startCharacter','endLine','endCharacter','calleeName','expressionHash','status'];
const LSP_OCCURRENCE_COLUMNS = ['id','runId','serverId','documentId','capability','requestUri','requestLine','requestCharacter','uri','startLine','startCharacter','endLine','endCharacter','selectionStartLine','selectionStartCharacter','selectionEndLine','selectionEndCharacter','originUri','originStartLine','originStartCharacter','originEndLine','originEndCharacter','role','status'];
const LSP_DIAGNOSTIC_COLUMNS = ['id','runId','serverId','documentId','capability','status','startLine','startCharacter','endLine','endCharacter','severity','code','codeHref','source','message','relatedInformationJson'];
const LSP_COVERAGE_COLUMNS = ['id','runId','serverId','documentId','languageId','capability','status','eligibleCount','attemptedCount','successCount','emptyCount','failureCount','timeoutCount','resultCount','mappedCount','externalCount','unmappedCount','exclusionReason'];
const LSP_HOVER_COLUMNS = ['id','runId','serverId','documentId','capability','requestLine','requestCharacter','startLine','startCharacter','endLine','endCharacter','contentFormat','contents','status'];
const LSP_SEMANTIC_TOKEN_COLUMNS = ['id','runId','serverId','documentId','capability','line','character','length','tokenType','status'];
const LSP_SIGNATURE_HELP_COLUMNS = ['id','runId','serverId','documentId','capability','requestLine','requestCharacter','activeSignature','activeParameter','status'];
const LSP_SIGNATURE_COLUMNS = ['id','signatureHelpId','label','documentation','activeParameter','ordinal'];
const LSP_PARAMETER_COLUMNS = ['id','signatureId','label','labelStart','labelEnd','documentation','ordinal'];
const LSP_RELATION_COLUMNS = ['from','to','id','kind','runId','serverId','capability','status','providerAuthority','mappingConfidence','isDerived','reason','ordinal'];

const DERIVED_RUN_COLUMNS = ['id','lspRunId','status','algorithmVersion','startedAt','completedAt','observationCount','invocationCount','normalizedObservationCount','ambiguousObservationCount','errorCount'];
const LOGICAL_INVOCATION_COLUMNS = ['id','stageId','runId','documentId','callerSymbolId','callerStableKey','targetFamilyId','targetFamilyStableKey','canonicalTargetId','canonicalTargetKind','startLine','startCharacter','endLine','endCharacter','observationCount','stableKey','status','confidence','algorithmVersion'];
const DERIVED_RELATION_COLUMNS = ['from','to','id','kind','stageId','confidence','ordinal'];

const BAZEL_RUN_COLUMNS = ['id','buildRootId','workspacePath','configurationHash','status','targetCount','sourceCount','artifactCount','relationCount','scopeConfigHash','scopeSelectorsJson','resolvedTargetCount','excludedTargetCount','excludedTargetsJson','scopeWarningsJson'];
const BAZEL_TARGET_COLUMNS = ['id','graphId','buildRootId','label','ruleKind','selected','codeOrigin'];
const BAZEL_SOURCE_COLUMNS = ['id','graphId','path','isGenerated','codeOrigin'];
const BAZEL_ARTIFACT_COLUMNS = ['id','graphId','path','codeOrigin'];
const BAZEL_RELATION_COLUMNS = ['from','to','id','graphId','kind','attribute','ordinal'];

const REPOSITORY_RUN_COLUMNS = ['id','workspacePath','status','documentCount','declarationCount'];
const REPOSITORY_PROVIDER_COLUMNS = ['id','runId','providerId','providerVersion','authority','status','discoveredCount','indexedCount','skippedCount','errorCount','errorsJson'];
const REPOSITORY_DOCUMENT_COLUMNS = ['id','runId','path','relativePath','languageId','kind','contentHash','byteSize','lineCount','codeOrigin','providerId','providerVersion','authority'];
const REPOSITORY_DECLARATION_COLUMNS = ['id','runId','documentId','kind','name','startLine','startCharacter','endLine','endCharacter','providerId','providerVersion','authority','codeOrigin'];
const REPOSITORY_RELATION_COLUMNS = ['from','to','kind'];
