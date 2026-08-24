/**
 * Flat LadybugDB row contracts and the only supported domain-to-storage
 * conversion boundary. Protocol ranges stay nested everywhere else.
 */

import type {
  LspAnalysisRun,
  LspBuildRoot,
  LspCallSite,
  LspCoverage,
  LspDiagnostic,
  LspDocument,
  LspHover,
  LspOccurrence,
  LspParameter,
  LspRange,
  LspRelation,
  LspSemanticToken,
  LspServer,
  LspSignature,
  LspSignatureHelp,
  LspSymbol,
  LspSymbolNodeTable,
} from '../model.js';
import {
  assertSelectionWithinRange,
  assertSymbolClass,
  assertValidRange,
  symbolNodeTable,
} from '../model.js';
import { relationEndpointPairs, relationKindEndpointPairs } from './schema.js';

type Nullable<T> = T | null;

export interface LspAnalysisRunRow {
  id: string;
  workspaceUri: string;
  repositoryPath: Nullable<string>;
  protocolVersion: string;
  positionEncoding: string;
  status: string;
  startedAt: string;
  completedAt: Nullable<string>;
  requestedLanguages: string[];
  configurationHash: Nullable<string>;
  errorCount: number;
  timeoutCount: number;
}

export interface LspServerRow {
  id: string;
  runId: string;
  name: string;
  version: Nullable<string>;
  languageId: string;
  command: Nullable<string>;
  status: string;
  capabilitiesJson: string;
  buildRootId: Nullable<string>;
}

export interface LspBuildRootRow {
  id: string;
  runId: string;
  workspaceUri: string;
  repositoryPath: Nullable<string>;
  relativePath: string;
  buildSystems: string[];
  javaMajor: Nullable<number>;
  importStatus: string;
  configurationHash: Nullable<string>;
  excludedRootIds: string[];
}

export interface LspDocumentRow {
  id: string;
  uri: string;
  filePath: Nullable<string>;
  languageId: string;
  version: Nullable<number>;
  contentHash: Nullable<string>;
  origin: string;
  wasOpened: boolean;
  buildRootId: Nullable<string>;
}

interface FlatRangeRow {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface LspSymbolRow extends FlatRangeRow {
  id: string;
  documentId: string;
  uri: string;
  name: string;
  detail: Nullable<string>;
  kind: number;
  kindName: string;
  tags: number[];
  containerName: Nullable<string>;
  selectionStartLine: number;
  selectionStartCharacter: number;
  selectionEndLine: number;
  selectionEndCharacter: number;
  signature: Nullable<string>;
  stableKey: string;
  isExternal: boolean;
}

/** Concrete persistence target plus its flat row. */
export interface LspSymbolRecord {
  table: LspSymbolNodeTable;
  row: LspSymbolRow;
}

export interface LspCallSiteRow extends FlatRangeRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  callerSymbolId: string;
  capability: string;
  direction: string;
  calleeName: Nullable<string>;
  expressionHash: Nullable<string>;
  status: string;
}

export interface LspOccurrenceRow extends FlatRangeRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  requestUri: Nullable<string>;
  requestLine: Nullable<number>;
  requestCharacter: Nullable<number>;
  uri: string;
  selectionStartLine: Nullable<number>;
  selectionStartCharacter: Nullable<number>;
  selectionEndLine: Nullable<number>;
  selectionEndCharacter: Nullable<number>;
  originUri: Nullable<string>;
  originStartLine: Nullable<number>;
  originStartCharacter: Nullable<number>;
  originEndLine: Nullable<number>;
  originEndCharacter: Nullable<number>;
  role: string;
  status: string;
}

export interface LspDiagnosticRow extends FlatRangeRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  status: string;
  severity: Nullable<number>;
  code: Nullable<string>;
  codeHref: Nullable<string>;
  source: Nullable<string>;
  message: string;
  tags: number[];
  relatedInformationJson: Nullable<string>;
}

export interface LspHoverRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  requestLine: number;
  requestCharacter: number;
  startLine: Nullable<number>;
  startCharacter: Nullable<number>;
  endLine: Nullable<number>;
  endCharacter: Nullable<number>;
  contentFormat: string;
  contents: string;
  status: string;
}

export interface LspSemanticTokenRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  line: number;
  character: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
  status: string;
}

export interface LspSignatureHelpRow {
  id: string;
  runId: string;
  serverId: string;
  documentId: string;
  capability: string;
  requestLine: number;
  requestCharacter: number;
  activeSignature: Nullable<number>;
  activeParameter: Nullable<number>;
  status: string;
}

export interface LspSignatureRow {
  id: string;
  signatureHelpId: string;
  label: string;
  documentation: Nullable<string>;
  activeParameter: Nullable<number>;
  ordinal: number;
}

export interface LspParameterRow {
  id: string;
  signatureId: string;
  label: string;
  labelStart: Nullable<number>;
  labelEnd: Nullable<number>;
  documentation: Nullable<string>;
  ordinal: number;
}

export interface LspCoverageRow {
  id: string;
  runId: string;
  serverId: Nullable<string>;
  documentId: Nullable<string>;
  languageId: string;
  capability: string;
  status: string;
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
  exclusionReason: Nullable<string>;
}

export interface LspRelationRow {
  from: string;
  to: string;
  id: string;
  kind: string;
  runId: string;
  serverId: Nullable<string>;
  capability: string;
  status: string;
  providerAuthority: number;
  mappingConfidence: number;
  isDerived: boolean;
  reason: Nullable<string>;
  ordinal: Nullable<number>;
}

export const toAnalysisRunRow = (value: LspAnalysisRun): LspAnalysisRunRow => ({
  ...value,
  repositoryPath: value.repositoryPath ?? null,
  completedAt: value.completedAt ?? null,
  configurationHash: value.configurationHash ?? null,
});

export const toServerRow = (value: LspServer): LspServerRow => ({
  ...value,
  version: value.version ?? null,
  command: value.command ?? null,
  buildRootId: value.buildRootId ?? null,
});

export const toBuildRootRow = (value: LspBuildRoot): LspBuildRootRow => ({
  ...value,
  repositoryPath: value.repositoryPath ?? null,
  javaMajor: value.javaMajor ?? null,
  configurationHash: value.configurationHash ?? null,
});

export const toDocumentRow = (value: LspDocument): LspDocumentRow => ({
  ...value,
  filePath: value.filePath ?? null,
  version: value.version ?? null,
  contentHash: value.contentHash ?? null,
  buildRootId: value.buildRootId ?? null,
});

export const toSymbolRow = (value: LspSymbol): LspSymbolRow => {
  assertSymbolClass(value);
  assertSelectionWithinRange(value.range, value.selectionRange);
  return {
    id: value.id,
    documentId: value.documentId,
    uri: value.uri,
    name: value.name,
    detail: value.detail ?? null,
    kind: value.kind,
    kindName: value.kindName,
    tags: value.tags,
    containerName: value.containerName ?? null,
    ...flattenRange(value.range),
    selectionStartLine: value.selectionRange.start.line,
    selectionStartCharacter: value.selectionRange.start.character,
    selectionEndLine: value.selectionRange.end.line,
    selectionEndCharacter: value.selectionRange.end.character,
    signature: value.signature ?? null,
    stableKey: value.stableKey,
    isExternal: value.isExternal,
  };
};

/** Routes a protocol symbol to its exact first-class Ladybug node table. */
export const toSymbolRecord = (value: LspSymbol): LspSymbolRecord => ({
  table: symbolNodeTable(value.kindName),
  row: toSymbolRow(value),
});

export const toCallSiteRow = (value: LspCallSite): LspCallSiteRow => {
  assertValidRange(value.range);
  return {
    id: value.id,
    runId: value.runId,
    serverId: value.serverId,
    documentId: value.documentId,
    callerSymbolId: value.callerSymbolId,
    capability: value.capability,
    direction: value.direction,
    ...flattenRange(value.range),
    calleeName: value.calleeName ?? null,
    expressionHash: value.expressionHash ?? null,
    status: value.status,
  };
};

export const toOccurrenceRow = (value: LspOccurrence): LspOccurrenceRow => {
  assertValidRange(value.range);
  if (value.selectionRange) assertValidRange(value.selectionRange, 'selectionRange');
  if (value.originRange) assertValidRange(value.originRange, 'originRange');
  return {
    id: value.id,
    runId: value.runId,
    serverId: value.serverId,
    documentId: value.documentId,
    capability: value.capability,
    requestUri: value.requestUri ?? null,
    requestLine: value.requestPosition?.line ?? null,
    requestCharacter: value.requestPosition?.character ?? null,
    uri: value.uri,
    ...flattenRange(value.range),
    selectionStartLine: value.selectionRange?.start.line ?? null,
    selectionStartCharacter: value.selectionRange?.start.character ?? null,
    selectionEndLine: value.selectionRange?.end.line ?? null,
    selectionEndCharacter: value.selectionRange?.end.character ?? null,
    originUri: value.originUri ?? null,
    originStartLine: value.originRange?.start.line ?? null,
    originStartCharacter: value.originRange?.start.character ?? null,
    originEndLine: value.originRange?.end.line ?? null,
    originEndCharacter: value.originRange?.end.character ?? null,
    role: value.role,
    status: value.status,
  };
};

export const toDiagnosticRow = (value: LspDiagnostic): LspDiagnosticRow => {
  assertValidRange(value.range);
  return {
    id: value.id,
    runId: value.runId,
    serverId: value.serverId,
    documentId: value.documentId,
    capability: value.capability,
    status: value.status,
    ...flattenRange(value.range),
    severity: value.severity ?? null,
    code: value.code ?? null,
    codeHref: value.codeHref ?? null,
    source: value.source ?? null,
    message: value.message,
    tags: value.tags,
    relatedInformationJson: value.relatedInformationJson ?? null,
  };
};

export const toHoverRow = (value: LspHover): LspHoverRow => {
  assertPosition(value.requestPosition.line, value.requestPosition.character, 'requestPosition');
  if (value.range) assertValidRange(value.range);
  return {
    id: value.id,
    runId: value.runId,
    serverId: value.serverId,
    documentId: value.documentId,
    capability: value.capability,
    requestLine: value.requestPosition.line,
    requestCharacter: value.requestPosition.character,
    startLine: value.range?.start.line ?? null,
    startCharacter: value.range?.start.character ?? null,
    endLine: value.range?.end.line ?? null,
    endCharacter: value.range?.end.character ?? null,
    contentFormat: value.contentFormat,
    contents: value.contents,
    status: value.status,
  };
};

export const toSemanticTokenRow = (value: LspSemanticToken): LspSemanticTokenRow => {
  assertPosition(value.line, value.character, 'semanticToken');
  if (!Number.isInteger(value.length) || value.length <= 0) {
    throw new Error(`semanticToken.length must be a positive integer, got ${value.length}`);
  }
  return { ...value };
};

export const toSignatureHelpRow = (value: LspSignatureHelp): LspSignatureHelpRow => {
  assertPosition(value.requestPosition.line, value.requestPosition.character, 'requestPosition');
  return {
    id: value.id,
    runId: value.runId,
    serverId: value.serverId,
    documentId: value.documentId,
    capability: value.capability,
    requestLine: value.requestPosition.line,
    requestCharacter: value.requestPosition.character,
    activeSignature: value.activeSignature ?? null,
    activeParameter: value.activeParameter ?? null,
    status: value.status,
  };
};

export const toSignatureRow = (value: LspSignature): LspSignatureRow => ({
  ...value,
  documentation: value.documentation ?? null,
  activeParameter: value.activeParameter ?? null,
});

export const toParameterRow = (value: LspParameter): LspParameterRow => {
  if ((value.labelStart === undefined) !== (value.labelEnd === undefined)) {
    throw new Error('parameter labelStart and labelEnd must either both be set or both be absent');
  }
  if (
    value.labelStart !== undefined &&
    (!Number.isInteger(value.labelStart) ||
      !Number.isInteger(value.labelEnd) ||
      value.labelStart < 0 ||
      value.labelEnd! < value.labelStart)
  ) {
    throw new Error('parameter label offsets must be ordered non-negative integers');
  }
  return {
    ...value,
    labelStart: value.labelStart ?? null,
    labelEnd: value.labelEnd ?? null,
    documentation: value.documentation ?? null,
  };
};

export const toCoverageRow = (value: LspCoverage): LspCoverageRow => ({
  ...value,
  serverId: value.serverId ?? null,
  documentId: value.documentId ?? null,
  exclusionReason: value.exclusionReason ?? null,
});

export const toRelationRow = (value: LspRelation): LspRelationRow => {
  const pair = `${value.sourceKind}|${value.targetKind}`;
  if (!relationEndpointPairs().has(pair)) {
    throw new Error(`LspRelation endpoint pair is not declared in LadybugDB: ${pair}`);
  }
  if (!relationKindEndpointPairs(value.kind).has(pair)) {
    throw new Error(`LspRelation kind ${value.kind} does not allow endpoint pair ${pair}`);
  }
  return {
    from: value.sourceId,
    to: value.targetId,
    id: value.id,
    kind: value.kind,
    runId: value.runId,
    serverId: value.serverId ?? null,
    capability: value.capability,
    status: value.status,
    providerAuthority: value.providerAuthority,
    mappingConfidence: value.mappingConfidence,
    isDerived: value.isDerived,
    reason: value.reason ?? null,
    ordinal: value.ordinal ?? null,
  };
};

function flattenRange(range: LspRange): FlatRangeRow {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function assertPosition(line: number, character: number, fieldName: string): void {
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    throw new Error(`${fieldName} must contain non-negative integer line and character values`);
  }
}
