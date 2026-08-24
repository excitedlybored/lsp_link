/** LadybugDB DDL for the isolated, LSP-native knowledge graph. */

import {
  LSP_ENTITY_KINDS,
  LSP_RELATION_KIND,
  LSP_SYMBOL_NODE_TABLES,
  type LspRelationKind,
  type LspSymbolNodeTable,
} from '../model.js';

export const LSP_NODE_TABLES = LSP_ENTITY_KINDS;
export type LspNodeTable = (typeof LSP_ENTITY_KINDS)[number];
export const LSP_RELATION_TABLE = 'LspRelation';

export const LSP_ANALYSIS_RUN_SCHEMA = `
CREATE NODE TABLE LspAnalysisRun (
  id STRING, workspaceUri STRING, repositoryPath STRING,
  protocolVersion STRING, positionEncoding STRING, status STRING,
  startedAt STRING, completedAt STRING, requestedLanguages STRING[],
  configurationHash STRING, errorCount INT64, timeoutCount INT64,
  PRIMARY KEY (id)
)`;

export const LSP_SERVER_SCHEMA = `
CREATE NODE TABLE LspServer (
  id STRING, runId STRING, name STRING, version STRING, languageId STRING,
  command STRING, status STRING, capabilitiesJson STRING, buildRootId STRING,
  PRIMARY KEY (id)
)`;

export const LSP_BUILD_ROOT_SCHEMA = `
CREATE NODE TABLE LspBuildRoot (
  id STRING, runId STRING, workspaceUri STRING, repositoryPath STRING,
  relativePath STRING, buildSystems STRING[], javaMajor INT32,
  importStatus STRING, configurationHash STRING, excludedRootIds STRING[],
  PRIMARY KEY (id)
)`;

export const LSP_DOCUMENT_SCHEMA = `
CREATE NODE TABLE LspDocument (
  id STRING, uri STRING, filePath STRING, languageId STRING, version INT64,
  contentHash STRING, origin STRING, wasOpened BOOLEAN, buildRootId STRING,
  PRIMARY KEY (id)
)`;

const symbolSchema = (table: LspSymbolNodeTable): string => `
CREATE NODE TABLE ${table} (
  id STRING, documentId STRING, uri STRING, name STRING, detail STRING,
  kind INT32, kindName STRING, tags INT32[], containerName STRING,
  startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
  selectionStartLine INT64, selectionStartCharacter INT64,
  selectionEndLine INT64, selectionEndCharacter INT64,
  signature STRING, stableKey STRING, isExternal BOOLEAN,
  PRIMARY KEY (id)
)`;

/** One physical node class for every standard LSP SymbolKind. */
export const LSP_SYMBOL_SCHEMAS = LSP_SYMBOL_NODE_TABLES.map(symbolSchema);

export const LSP_CALL_SITE_SCHEMA = `
CREATE NODE TABLE LspCallSite (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  callerSymbolId STRING, capability STRING, direction STRING,
  startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
  calleeName STRING, expressionHash STRING, status STRING,
  PRIMARY KEY (id)
)`;

export const LSP_OCCURRENCE_SCHEMA = `
CREATE NODE TABLE LspOccurrence (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  capability STRING, uri STRING,
  startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
  selectionStartLine INT64, selectionStartCharacter INT64,
  selectionEndLine INT64, selectionEndCharacter INT64,
  originUri STRING, originStartLine INT64, originStartCharacter INT64,
  originEndLine INT64, originEndCharacter INT64,
  role STRING, status STRING,
  PRIMARY KEY (id)
)`;

export const LSP_DIAGNOSTIC_SCHEMA = `
CREATE NODE TABLE LspDiagnostic (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  capability STRING, status STRING,
  startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
  severity INT32, code STRING, codeHref STRING, source STRING, message STRING,
  tags INT32[], relatedInformationJson STRING,
  PRIMARY KEY (id)
)`;

export const LSP_HOVER_SCHEMA = `
CREATE NODE TABLE LspHover (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  capability STRING, requestLine INT64, requestCharacter INT64,
  startLine INT64, startCharacter INT64, endLine INT64, endCharacter INT64,
  contentFormat STRING, contents STRING, status STRING,
  PRIMARY KEY (id)
)`;

export const LSP_SEMANTIC_TOKEN_SCHEMA = `
CREATE NODE TABLE LspSemanticToken (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  capability STRING, line INT64, character INT64, length INT64,
  tokenType STRING, tokenModifiers STRING[], status STRING,
  PRIMARY KEY (id)
)`;

export const LSP_SIGNATURE_HELP_SCHEMA = `
CREATE NODE TABLE LspSignatureHelp (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  capability STRING, requestLine INT64, requestCharacter INT64,
  activeSignature INT32, activeParameter INT32, status STRING,
  PRIMARY KEY (id)
)`;

export const LSP_SIGNATURE_SCHEMA = `
CREATE NODE TABLE LspSignature (
  id STRING, signatureHelpId STRING, label STRING, documentation STRING,
  activeParameter INT32, ordinal INT32,
  PRIMARY KEY (id)
)`;

export const LSP_PARAMETER_SCHEMA = `
CREATE NODE TABLE LspParameter (
  id STRING, signatureId STRING, label STRING, labelStart INT32,
  labelEnd INT32, documentation STRING, ordinal INT32,
  PRIMARY KEY (id)
)`;

export const LSP_COVERAGE_SCHEMA = `
CREATE NODE TABLE LspCoverage (
  id STRING, runId STRING, serverId STRING, documentId STRING,
  languageId STRING, capability STRING, status STRING,
  eligibleCount INT64, attemptedCount INT64, successCount INT64,
  emptyCount INT64, failureCount INT64, timeoutCount INT64,
  resultCount INT64, mappedCount INT64, externalCount INT64,
  unmappedCount INT64, exclusionReason STRING,
  PRIMARY KEY (id)
)`;

const pair = (from: LspNodeTable, to: LspNodeTable): string => `${from}|${to}`;
const symbolPairs = (): string[] =>
  LSP_SYMBOL_NODE_TABLES.flatMap((from) => LSP_SYMBOL_NODE_TABLES.map((to) => pair(from, to)));
const fromEachSymbol = (to: LspNodeTable): string[] =>
  LSP_SYMBOL_NODE_TABLES.map((from) => pair(from, to));
const toEachSymbol = (from: LspNodeTable): string[] =>
  LSP_SYMBOL_NODE_TABLES.map((to) => pair(from, to));

/**
 * Ladybug relationship groups require concrete endpoint pairs. The expanded
 * matrix is deliberate: no generic LspSymbol storage class remains.
 */
const RELATION_ENDPOINT_PAIR_LIST = [
  pair('LspAnalysisRun', 'LspServer'),
  pair('LspAnalysisRun', 'LspBuildRoot'),
  pair('LspServer', 'LspBuildRoot'),
  pair('LspBuildRoot', 'LspDocument'),
  pair('LspAnalysisRun', 'LspDocument'),
  pair('LspAnalysisRun', 'LspCoverage'),
  pair('LspServer', 'LspCoverage'),
  ...toEachSymbol('LspDocument'),
  pair('LspDocument', 'LspOccurrence'),
  pair('LspDocument', 'LspDiagnostic'),
  pair('LspDocument', 'LspHover'),
  pair('LspDocument', 'LspSemanticToken'),
  pair('LspDocument', 'LspSignatureHelp'),
  ...toEachSymbol('LspHover'),
  ...toEachSymbol('LspSemanticToken'),
  pair('LspSignatureHelp', 'LspSignature'),
  pair('LspSignature', 'LspParameter'),
  ...symbolPairs(),
  ...fromEachSymbol('LspCallSite'),
  ...toEachSymbol('LspCallSite'),
  ...toEachSymbol('LspOccurrence'),
] as const;

const RELATION_ENDPOINT_CLAUSES = RELATION_ENDPOINT_PAIR_LIST.map((endpoint) => {
  const [from, to] = endpoint.split('|');
  return `  FROM ${from} TO ${to}`;
}).join(',\n');

export const LSP_RELATION_SCHEMA = `
CREATE REL TABLE LspRelation (
${RELATION_ENDPOINT_CLAUSES},
  id STRING, kind STRING, runId STRING, serverId STRING,
  capability STRING, status STRING, providerAuthority DOUBLE,
  mappingConfidence DOUBLE, isDerived BOOLEAN, reason STRING, ordinal INT32
)`;

export const LSP_NODE_SCHEMA_QUERIES = [
  LSP_ANALYSIS_RUN_SCHEMA,
  LSP_SERVER_SCHEMA,
  LSP_BUILD_ROOT_SCHEMA,
  LSP_DOCUMENT_SCHEMA,
  ...LSP_SYMBOL_SCHEMAS,
  LSP_CALL_SITE_SCHEMA,
  LSP_OCCURRENCE_SCHEMA,
  LSP_DIAGNOSTIC_SCHEMA,
  LSP_COVERAGE_SCHEMA,
  LSP_HOVER_SCHEMA,
  LSP_SEMANTIC_TOKEN_SCHEMA,
  LSP_SIGNATURE_HELP_SCHEMA,
  LSP_SIGNATURE_SCHEMA,
  LSP_PARAMETER_SCHEMA,
] as const;

export const LSP_SCHEMA_QUERIES = [...LSP_NODE_SCHEMA_QUERIES, LSP_RELATION_SCHEMA] as const;

export function relationEndpointPairs(): ReadonlySet<string> {
  return new Set(RELATION_ENDPOINT_PAIR_LIST);
}

const endpointSet = (...pairs: string[]): ReadonlySet<string> => new Set(pairs);

/** Exact legal concrete endpoint pairs per semantic relationship kind. */
export const LSP_RELATION_KIND_ENDPOINTS: Readonly<Record<LspRelationKind, ReadonlySet<string>>> = {
  [LSP_RELATION_KIND.UsesServer]: endpointSet(pair('LspAnalysisRun', 'LspServer')),
  [LSP_RELATION_KIND.HasBuildRoot]: endpointSet(pair('LspAnalysisRun', 'LspBuildRoot')),
  [LSP_RELATION_KIND.ImportsBuildRoot]: endpointSet(pair('LspServer', 'LspBuildRoot')),
  [LSP_RELATION_KIND.OwnsDocument]: endpointSet(pair('LspBuildRoot', 'LspDocument')),
  [LSP_RELATION_KIND.AnalyzedDocument]: endpointSet(pair('LspAnalysisRun', 'LspDocument')),
  [LSP_RELATION_KIND.ReportsCoverage]: endpointSet(
    pair('LspAnalysisRun', 'LspCoverage'), pair('LspServer', 'LspCoverage'),
  ),
  [LSP_RELATION_KIND.Defines]: endpointSet(...toEachSymbol('LspDocument')),
  [LSP_RELATION_KIND.Contains]: endpointSet(...symbolPairs()),
  [LSP_RELATION_KIND.HasCallSite]: endpointSet(...fromEachSymbol('LspCallSite')),
  [LSP_RELATION_KIND.ResolvesTo]: endpointSet(...toEachSymbol('LspCallSite')),
  [LSP_RELATION_KIND.ContainsOccurrence]: endpointSet(pair('LspDocument', 'LspOccurrence')),
  [LSP_RELATION_KIND.DefinitionOf]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.TypeDefinitionOf]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.DeclarationOf]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.ReferenceTo]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.ImplementationLocationOf]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.TypeHierarchyLocationOf]: endpointSet(...toEachSymbol('LspOccurrence')),
  [LSP_RELATION_KIND.ImplementationOf]: endpointSet(...symbolPairs()),
  [LSP_RELATION_KIND.TypeHierarchySupertype]: endpointSet(...symbolPairs()),
  [LSP_RELATION_KIND.HasDiagnostic]: endpointSet(pair('LspDocument', 'LspDiagnostic')),
  [LSP_RELATION_KIND.HasHover]: endpointSet(pair('LspDocument', 'LspHover')),
  [LSP_RELATION_KIND.HoverDescribesSymbol]: endpointSet(...toEachSymbol('LspHover')),
  [LSP_RELATION_KIND.HasSemanticToken]: endpointSet(pair('LspDocument', 'LspSemanticToken')),
  [LSP_RELATION_KIND.SemanticTokenDescribesSymbol]: endpointSet(...toEachSymbol('LspSemanticToken')),
  [LSP_RELATION_KIND.HasSignatureHelp]: endpointSet(pair('LspDocument', 'LspSignatureHelp')),
  [LSP_RELATION_KIND.HasSignature]: endpointSet(pair('LspSignatureHelp', 'LspSignature')),
  [LSP_RELATION_KIND.HasParameter]: endpointSet(pair('LspSignature', 'LspParameter')),
};

export function relationKindEndpointPairs(kind: LspRelationKind): ReadonlySet<string> {
  return LSP_RELATION_KIND_ENDPOINTS[kind];
}
