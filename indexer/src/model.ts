import type { CodeOrigin } from './code-origin.js';

/**
 * LSP-native persisted data classes.
 *
 * These classes deliberately preserve protocol observations before projecting
 * them into GitNexus concepts such as Class, Method, CALLS, or IMPLEMENTS.
 */

export const LSP_SYMBOL_KIND = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

export type LspSymbolKind = (typeof LSP_SYMBOL_KIND)[keyof typeof LSP_SYMBOL_KIND];
export type LspSymbolKindName = keyof typeof LSP_SYMBOL_KIND;

/**
 * Physical LadybugDB node classes for the 26 standard LSP SymbolKind values.
 * A protocol kind is never folded into a generic symbol table or a nearby
 * GitNexus class (for example Field -> Property).
 */
export const LSP_SYMBOL_NODE_TABLE = {
  File: 'LspFileSymbol',
  Module: 'LspModuleSymbol',
  Namespace: 'LspNamespaceSymbol',
  Package: 'LspPackageSymbol',
  Class: 'LspClassSymbol',
  Method: 'LspMethodSymbol',
  Property: 'LspPropertySymbol',
  Field: 'LspFieldSymbol',
  Constructor: 'LspConstructorSymbol',
  Enum: 'LspEnumSymbol',
  Interface: 'LspInterfaceSymbol',
  Function: 'LspFunctionSymbol',
  Variable: 'LspVariableSymbol',
  Constant: 'LspConstantSymbol',
  String: 'LspStringSymbol',
  Number: 'LspNumberSymbol',
  Boolean: 'LspBooleanSymbol',
  Array: 'LspArraySymbol',
  Object: 'LspObjectSymbol',
  Key: 'LspKeySymbol',
  Null: 'LspNullSymbol',
  EnumMember: 'LspEnumMemberSymbol',
  Struct: 'LspStructSymbol',
  Event: 'LspEventSymbol',
  Operator: 'LspOperatorSymbol',
  TypeParameter: 'LspTypeParameterSymbol',
} as const satisfies Record<LspSymbolKindName, string>;

export type LspSymbolNodeTable = (typeof LSP_SYMBOL_NODE_TABLE)[LspSymbolKindName];
export const LSP_SYMBOL_NODE_TABLES = Object.values(LSP_SYMBOL_NODE_TABLE) as LspSymbolNodeTable[];

export type LspPositionEncoding = 'utf-8' | 'utf-16' | 'utf-32' | string;
export type LspRunStatus =
  | 'not_requested'
  | 'unavailable'
  | 'failed'
  | 'partial'
  | 'complete';
export type LspObservationStatus =
  | 'not_attempted'
  | 'unsupported'
  | 'excluded'
  | 'failed'
  | 'timeout'
  | 'partial'
  | 'empty'
  | 'observed'
  | 'mapped'
  | 'unmapped';
export type LspDocumentOrigin = 'workspace' | 'generated' | 'dependency' | 'standard_library' | 'unknown';
export type LspOccurrenceRole =
  | 'declaration'
  | 'definition'
  | 'type_definition'
  | 'reference'
  | 'implementation'
  | 'type_super'
  | 'type_sub';
export type LspCallHierarchyDirection = 'incoming' | 'outgoing';
export type LspHoverContentFormat = 'plaintext' | 'markdown' | 'marked_string' | 'mixed';

export const LSP_ENTITY_KINDS = [
  'LspAnalysisRun',
  'LspServer',
  'LspBuildRoot',
  'LspDocument',
  'LspCallSite',
  'LspOccurrence',
  'LspDiagnostic',
  'LspCoverage',
  'LspHover',
  'LspSemanticToken',
  'LspSignatureHelp',
  'LspSignature',
  'LspParameter',
  ...LSP_SYMBOL_NODE_TABLES,
] as const;

export type LspEntityKind = (typeof LSP_ENTITY_KINDS)[number];

export interface LspPosition {
  /** Zero-based, exactly as represented by LSP. */
  line: number;
  /** Zero-based units in the analysis run's negotiated position encoding. */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspAnalysisRun {
  id: string;
  workspaceUri: string;
  repositoryPath?: string;
  protocolVersion: string;
  positionEncoding: LspPositionEncoding;
  status: LspRunStatus;
  startedAt: string;
  completedAt?: string;
  requestedLanguages: string[];
  configurationHash?: string;
  errorCount: number;
  timeoutCount: number;
}

export interface LspServer {
  id: string;
  runId: string;
  name: string;
  version?: string;
  languageId: string;
  command?: string;
  status: LspRunStatus;
  capabilitiesJson: string;
  /** Lossless provider-specific responses not represented by standard LSP types. */
  observationsJson?: string;
  buildRootId?: string;
  /** Physical persistent language-server process shared by logical root servers. */
  processShardId?: string;
}

export interface LspBuildRoot {
  id: string;
  runId: string;
  workspaceUri: string;
  repositoryPath?: string;
  relativePath: string;
  buildSystems: string[];
  javaMajor?: number;
  importStatus: 'ready' | 'partial' | 'disabled' | 'failed' | 'missing_external_model';
  configurationHash?: string;
  excludedRootIds: string[];
}

export interface LspDocument {
  id: string;
  uri: string;
  filePath?: string;
  languageId: string;
  version?: number;
  contentHash?: string;
  origin: LspDocumentOrigin;
  codeOrigin: CodeOrigin;
  /** Whether this run successfully sent textDocument/didOpen for the document. */
  wasOpened: boolean;
  buildRootId?: string;
}

export interface LspSymbolCommon {
  id: string;
  documentId: string;
  uri: string;
  name: string;
  detail?: string;
  tags: number[];
  containerName?: string;
  range: LspRange;
  selectionRange: LspRange;
  signature?: string;
  stableKey: string;
  isExternal: boolean;
  codeOrigin: CodeOrigin;
}

/** One exact data class for a standard LSP SymbolKind. */
export type LspSymbolOf<Name extends LspSymbolKindName> = LspSymbolCommon & {
  kindName: Name;
  kind: (typeof LSP_SYMBOL_KIND)[Name];
};

export type LspFileSymbol = LspSymbolOf<'File'>;
export type LspModuleSymbol = LspSymbolOf<'Module'>;
export type LspNamespaceSymbol = LspSymbolOf<'Namespace'>;
export type LspPackageSymbol = LspSymbolOf<'Package'>;
export type LspClassSymbol = LspSymbolOf<'Class'>;
export type LspMethodSymbol = LspSymbolOf<'Method'>;
export type LspPropertySymbol = LspSymbolOf<'Property'>;
export type LspFieldSymbol = LspSymbolOf<'Field'>;
export type LspConstructorSymbol = LspSymbolOf<'Constructor'>;
export type LspEnumSymbol = LspSymbolOf<'Enum'>;
export type LspInterfaceSymbol = LspSymbolOf<'Interface'>;
export type LspFunctionSymbol = LspSymbolOf<'Function'>;
export type LspVariableSymbol = LspSymbolOf<'Variable'>;
export type LspConstantSymbol = LspSymbolOf<'Constant'>;
export type LspStringSymbol = LspSymbolOf<'String'>;
export type LspNumberSymbol = LspSymbolOf<'Number'>;
export type LspBooleanSymbol = LspSymbolOf<'Boolean'>;
export type LspArraySymbol = LspSymbolOf<'Array'>;
export type LspObjectSymbol = LspSymbolOf<'Object'>;
export type LspKeySymbol = LspSymbolOf<'Key'>;
export type LspNullSymbol = LspSymbolOf<'Null'>;
export type LspEnumMemberSymbol = LspSymbolOf<'EnumMember'>;
export type LspStructSymbol = LspSymbolOf<'Struct'>;
export type LspEventSymbol = LspSymbolOf<'Event'>;
export type LspOperatorSymbol = LspSymbolOf<'Operator'>;
export type LspTypeParameterSymbol = LspSymbolOf<'TypeParameter'>;

/** Exhaustive union: adding a standard kind to the map adds it here. */
export type LspSymbol = {
  [Name in LspSymbolKindName]: LspSymbolOf<Name>;
}[LspSymbolKindName];

export interface LspCallSite {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  callerSymbolId: string;
  capability: 'callHierarchy/incomingCalls' | 'callHierarchy/outgoingCalls' | 'gitnexus.java/batchCalls';
  direction: LspCallHierarchyDirection;
  range: LspRange;
  calleeName?: string;
  expressionHash?: string;
  status: LspObservationStatus;
}

export interface LspOccurrence {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  /** Cursor sent to the provider; retained even when a Location has no origin. */
  requestUri?: string;
  requestPosition?: LspPosition;
  /** URI and range returned by the server. */
  uri: string;
  range: LspRange;
  /** Selection range when the server returned LocationLink rather than Location. */
  selectionRange?: LspRange;
  /** Request-side token when LocationLink.originSelectionRange is available. */
  originUri?: string;
  originRange?: LspRange;
  role: LspOccurrenceRole;
  status: LspObservationStatus;
}

export interface LspDiagnostic {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: 'textDocument/publishDiagnostics' | 'textDocument/diagnostic' | 'workspace/diagnostic';
  status: LspObservationStatus;
  range: LspRange;
  severity?: number;
  code?: string;
  codeHref?: string;
  source?: string;
  message: string;
  tags: number[];
  relatedInformationJson?: string;
}

export interface LspHover {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: 'textDocument/hover';
  requestPosition: LspPosition;
  range?: LspRange;
  contentFormat: LspHoverContentFormat;
  contents: string;
  status: LspObservationStatus;
}

export interface LspSemanticToken {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability:
    | 'textDocument/semanticTokens/full'
    | 'textDocument/semanticTokens/full/delta'
    | 'textDocument/semanticTokens/range';
  /** Decoded absolute zero-based token position. */
  line: number;
  character: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
  status: LspObservationStatus;
}

export interface LspSignatureHelp {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: 'textDocument/signatureHelp';
  requestPosition: LspPosition;
  activeSignature?: number;
  activeParameter?: number;
  status: LspObservationStatus;
}

export interface LspSignature {
  id: string;
  signatureHelpId: string;
  label: string;
  documentation?: string;
  activeParameter?: number;
  ordinal: number;
}

export interface LspParameter {
  id: string;
  signatureId: string;
  label: string;
  labelStart?: number;
  labelEnd?: number;
  documentation?: string;
  ordinal: number;
}

export interface LspCoverage {
  id: string;
  runId: string;
  serverId?: string;
  documentId?: string;
  languageId: string;
  capability: string;
  status: LspObservationStatus;
  eligibleCount: number;
  attemptedCount: number;
  successCount: number;
  emptyCount: number;
  failureCount: number;
  timeoutCount: number;
  resultCount: number;
  mappedCount: number;
  externalCount: number;
  unmappedCount: number;
  exclusionReason?: string;
}

export const LSP_RELATION_KIND = {
  UsesServer: 'USES_SERVER',
  HasBuildRoot: 'HAS_BUILD_ROOT',
  ImportsBuildRoot: 'IMPORTS_BUILD_ROOT',
  OwnsDocument: 'OWNS_DOCUMENT',
  AnalyzedDocument: 'ANALYZED_DOCUMENT',
  ReportsCoverage: 'REPORTS_COVERAGE',
  Defines: 'DEFINES',
  Contains: 'CONTAINS',
  HasCallSite: 'HAS_CALLSITE',
  ResolvesTo: 'RESOLVES_TO',
  ContainsOccurrence: 'CONTAINS_OCCURRENCE',
  DefinitionOf: 'DEFINITION_OF',
  TypeDefinitionOf: 'TYPE_DEFINITION_OF',
  DeclarationOf: 'DECLARATION_OF',
  ReferenceTo: 'REFERENCE_TO',
  ImplementationLocationOf: 'IMPLEMENTATION_LOCATION_OF',
  TypeHierarchyLocationOf: 'TYPE_HIERARCHY_LOCATION_OF',
  ImplementationOf: 'IMPLEMENTATION_OF',
  TypeHierarchySupertype: 'TYPE_HIERARCHY_SUPERTYPE',
  HasDiagnostic: 'HAS_DIAGNOSTIC',
  HasHover: 'HAS_HOVER',
  HoverDescribesSymbol: 'HOVER_DESCRIBES_SYMBOL',
  HasSemanticToken: 'HAS_SEMANTIC_TOKEN',
  SemanticTokenDescribesSymbol: 'SEMANTIC_TOKEN_DESCRIBES_SYMBOL',
  HasSignatureHelp: 'HAS_SIGNATURE_HELP',
  HasSignature: 'HAS_SIGNATURE',
  HasParameter: 'HAS_PARAMETER',
} as const;

export type LspRelationKind = (typeof LSP_RELATION_KIND)[keyof typeof LSP_RELATION_KIND];

export interface LspRelation {
  id: string;
  sourceKind: LspEntityKind;
  sourceId: string;
  targetKind: LspEntityKind;
  targetId: string;
  kind: LspRelationKind;
  runId: string;
  serverId?: string;
  capability: string;
  status: LspObservationStatus;
  providerAuthority: number;
  mappingConfidence: number;
  isDerived: boolean;
  reason?: string;
  ordinal?: number;
}

export function symbolKindName(kind: number): LspSymbolKindName | 'Unknown' {
  for (const [name, value] of Object.entries(LSP_SYMBOL_KIND)) {
    if (value === kind) return name as LspSymbolKindName;
  }
  return 'Unknown';
}

export function symbolNodeTable(kindName: LspSymbolKindName): LspSymbolNodeTable {
  return LSP_SYMBOL_NODE_TABLE[kindName];
}

export function assertSymbolClass(
  symbol: Pick<LspSymbolCommon, 'id'> & { kind: number; kindName: string },
): asserts symbol is Pick<LspSymbol, 'id' | 'kind' | 'kindName'> {
  const expectedName = symbolKindName(symbol.kind);
  if (expectedName === 'Unknown') {
    throw new Error(`LSP symbol ${symbol.id} has unknown SymbolKind ${symbol.kind}`);
  }
  if (expectedName !== symbol.kindName) {
    throw new Error(
      `LSP symbol ${symbol.id} has incompatible class: kind ${symbol.kind} is ${expectedName}, not ${symbol.kindName}`,
    );
  }
}

export function assertValidRange(range: LspRange, fieldName = 'range'): void {
  for (const [name, value] of [
    [`${fieldName}.start.line`, range.start.line],
    [`${fieldName}.start.character`, range.start.character],
    [`${fieldName}.end.line`, range.end.line],
    [`${fieldName}.end.character`, range.end.character],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, got ${value}`);
    }
  }
  if (
    range.end.line < range.start.line ||
    (range.end.line === range.start.line && range.end.character < range.start.character)
  ) {
    throw new Error(`${fieldName}.end must not precede ${fieldName}.start`);
  }
}

export function assertSelectionWithinRange(range: LspRange, selectionRange: LspRange): void {
  assertValidRange(range, 'range');
  assertValidRange(selectionRange, 'selectionRange');
  if (comparePosition(selectionRange.start, range.start) < 0 || comparePosition(selectionRange.end, range.end) > 0) {
    throw new Error('selectionRange must be contained within range');
  }
}

function comparePosition(left: LspPosition, right: LspPosition): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}
