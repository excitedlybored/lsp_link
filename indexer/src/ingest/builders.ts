import {
  LSP_RELATION_KIND,
  assertSymbolClass,
  symbolKindName,
  type LspCallHierarchyDirection,
  type LspAnalysisRun,
  type LspBuildRoot,
  type LspDocument,
  type LspOccurrence,
  type LspOccurrenceRole,
  type LspRange,
  type LspRelation,
  type LspRelationKind,
  type LspServer,
  type LspSymbol,
  type LspSymbolKind,
  type LspSymbolKindName,
} from '../model.js';
import { emptyObservationBatch, type LspObservationBatch } from './batch.js';

export interface DocumentSymbolObservation {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  containerName?: string;
  children?: DocumentSymbolObservation[];
}

export interface IngestionContext {
  runId: string;
  server: Pick<LspServer, 'id'>;
  document: LspDocument;
  capability: string;
  providerAuthority?: number;
}

export interface NormalizedCallObservation {
  caller: LspSymbol;
  target: LspSymbol;
  /** Every range is caller-relative and becomes a distinct node. */
  fromRanges: LspRange[];
}

export function ingestRun(
  run: LspAnalysisRun,
  servers: LspServer[],
  documents: LspDocument[],
  buildRoots: LspBuildRoot[] = [],
): LspObservationBatch {
  const batch = emptyObservationBatch();
  batch.analysisRuns.push(run);
  for (const server of servers) batch.servers.push(server);
  for (const buildRoot of buildRoots) batch.buildRoots.push(buildRoot);
  for (const document of documents) batch.documents.push(document);
  for (const [ordinal, server] of servers.entries()) {
    batch.relations.push({
      id: stableId('relation', run.id, LSP_RELATION_KIND.UsesServer, server.id),
      sourceKind: 'LspAnalysisRun', sourceId: run.id,
      targetKind: 'LspServer', targetId: server.id,
      kind: LSP_RELATION_KIND.UsesServer,
      runId: run.id, serverId: server.id, capability: 'initialize',
      status: 'observed', providerAuthority: 1, mappingConfidence: 1,
      isDerived: false, ordinal,
    });
  }
  for (const [ordinal, document] of documents.entries()) {
    batch.relations.push({
      id: stableId('relation', run.id, LSP_RELATION_KIND.AnalyzedDocument, document.id),
      sourceKind: 'LspAnalysisRun', sourceId: run.id,
      targetKind: 'LspDocument', targetId: document.id,
      kind: LSP_RELATION_KIND.AnalyzedDocument,
      runId: run.id, capability: 'textDocument/didOpen',
      status: document.wasOpened ? 'observed' : 'not_attempted',
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
    });
  }
  for (const [ordinal, root] of buildRoots.entries()) {
    batch.relations.push({
      id: stableId('relation', run.id, LSP_RELATION_KIND.HasBuildRoot, root.id),
      sourceKind: 'LspAnalysisRun', sourceId: run.id,
      targetKind: 'LspBuildRoot', targetId: root.id,
      kind: LSP_RELATION_KIND.HasBuildRoot,
      runId: run.id, capability: 'workspace/buildRoots', status: 'observed',
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
    });
  }
  for (const [ordinal, server] of servers.entries()) {
    if (!server.buildRootId) continue;
    batch.relations.push({
      id: stableId('relation', run.id, LSP_RELATION_KIND.ImportsBuildRoot, server.id, server.buildRootId),
      sourceKind: 'LspServer', sourceId: server.id,
      targetKind: 'LspBuildRoot', targetId: server.buildRootId,
      kind: LSP_RELATION_KIND.ImportsBuildRoot,
      runId: run.id, serverId: server.id, capability: 'workspace/buildRoots', status: 'observed',
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
    });
  }
  for (const [ordinal, document] of documents.entries()) {
    if (!document.buildRootId) continue;
    batch.relations.push({
      id: stableId('relation', run.id, LSP_RELATION_KIND.OwnsDocument, document.buildRootId, document.id),
      sourceKind: 'LspBuildRoot', sourceId: document.buildRootId,
      targetKind: 'LspDocument', targetId: document.id,
      kind: LSP_RELATION_KIND.OwnsDocument,
      runId: run.id, capability: 'workspace/buildRoots', status: 'mapped',
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
    });
  }
  return batch;
}

export function ingestDocumentSymbols(
  context: IngestionContext,
  observations: DocumentSymbolObservation[],
): LspObservationBatch {
  const batch = emptyObservationBatch();
  let ordinal = 0;

  const visit = (observation: DocumentSymbolObservation, parent?: LspSymbol): void => {
    const kindName = requireKindName(observation.kind);
    const symbol = materializeSymbol(
      context.document,
      observation,
      kindName,
      parent?.stableKey,
    );
    batch.symbols.push(symbol);
    batch.relations.push(makeRelation(
      context,
      parent ? parent.kindName : 'document',
      parent?.id ?? context.document.id,
      symbol.kindName,
      symbol.id,
      parent ? LSP_RELATION_KIND.Contains : LSP_RELATION_KIND.Defines,
      ordinal++,
    ));
    for (const child of observation.children ?? []) visit(child, symbol);
  };

  for (const observation of observations) visit(observation);
  return batch;
}

export function ingestCalls(
  context: IngestionContext,
  direction: LspCallHierarchyDirection,
  calls: NormalizedCallObservation[],
): LspObservationBatch {
  const batch = emptyObservationBatch();
  let ordinal = 0;
  for (const call of calls) {
    assertSymbolClass(call.caller);
    assertSymbolClass(call.target);
    for (const range of call.fromRanges) {
      const callSiteId = stableId(
        'callsite', context.runId, context.server.id, context.capability,
        direction, call.caller.id, rangeKey(range), String(ordinal),
      );
      batch.callSites.push({
        id: callSiteId,
        runId: context.runId,
        serverId: context.server.id,
        documentId: call.caller.documentId,
        callerSymbolId: call.caller.id,
        capability: direction === 'incoming'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls',
        direction,
        range,
        calleeName: call.target.name,
        status: 'mapped',
      });
      batch.relations.push(
        makeRelation(context, call.caller.kindName, call.caller.id, 'callsite', callSiteId, LSP_RELATION_KIND.HasCallSite, ordinal),
        makeRelation(context, 'callsite', callSiteId, call.target.kindName, call.target.id, LSP_RELATION_KIND.ResolvesTo, ordinal),
      );
      ordinal += 1;
    }
  }
  return batch;
}

export function ingestOccurrence(
  context: IngestionContext,
  occurrence: Omit<LspOccurrence, 'runId' | 'serverId' | 'documentId' | 'capability'>,
  target?: LspSymbol,
): LspObservationBatch {
  const batch = emptyObservationBatch();
  const value: LspOccurrence = {
    ...occurrence,
    runId: context.runId,
    serverId: context.server.id,
    documentId: context.document.id,
    capability: context.capability,
  };
  batch.occurrences.push(value);
  batch.relations.push(makeRelation(
    context, 'document', context.document.id, 'occurrence', value.id,
    LSP_RELATION_KIND.ContainsOccurrence, 0,
  ));
  if (target) {
    batch.relations.push(makeRelation(
      context, 'occurrence', value.id, target.kindName, target.id,
      occurrenceRelationKind(value.role), 1,
    ));
  }
  return batch;
}

export function makeMappedSymbolRelation(
  context: IngestionContext,
  source: LspSymbol,
  target: LspSymbol,
  kind: 'implementation' | 'type_super',
): LspRelation {
  return makeRelation(
    context,
    source.kindName,
    source.id,
    target.kindName,
    target.id,
    kind === 'implementation'
      ? LSP_RELATION_KIND.ImplementationOf
      : LSP_RELATION_KIND.TypeHierarchySupertype,
    0,
  );
}

export function materializeSymbol(
  document: LspDocument,
  observation: DocumentSymbolObservation,
  knownKindName?: LspSymbolKindName,
  parentStableKey?: string,
): LspSymbol {
  const kindName = knownKindName ?? requireKindName(observation.kind);
  const id = stableId(
    'symbol', document.uri, kindName, observation.name,
    rangeKey(observation.selectionRange), observation.detail ?? '',
  );
  const semanticContainer = parentStableKey ?? observation.containerName ?? '';
  const semanticKey = stableId(
    'semantic-symbol',
    document.uri,
    semanticContainer,
    kindName,
    observation.name,
    observation.detail ?? '',
  );
  return {
    id,
    documentId: document.id,
    uri: document.uri,
    name: observation.name,
    detail: observation.detail,
    kind: observation.kind as LspSymbolKind,
    kindName,
    tags: observation.tags ?? [],
    containerName: observation.containerName,
    range: observation.range,
    selectionRange: observation.selectionRange,
    signature: observation.detail,
    stableKey: semanticKey,
    isExternal: document.origin !== 'workspace',
  } as LspSymbol;
}

function makeRelation(
  context: IngestionContext,
  source: LspSymbolKindName | 'document' | 'callsite' | 'occurrence',
  sourceId: string,
  target: LspSymbolKindName | 'callsite' | 'occurrence',
  targetId: string,
  kind: LspRelationKind,
  ordinal: number,
): LspRelation {
  const sourceKind = source === 'document'
    ? 'LspDocument'
    : source === 'callsite'
      ? 'LspCallSite'
      : source === 'occurrence'
        ? 'LspOccurrence'
        : `Lsp${source}Symbol`;
  const targetKind = target === 'callsite'
    ? 'LspCallSite'
    : target === 'occurrence'
      ? 'LspOccurrence'
      : `Lsp${target}Symbol`;
  return {
    id: stableId(
      'relation', context.runId, context.server.id, context.capability,
      kind, sourceId, targetId, String(ordinal),
    ),
    sourceKind: sourceKind as LspRelation['sourceKind'],
    sourceId,
    targetKind: targetKind as LspRelation['targetKind'],
    targetId,
    kind,
    runId: context.runId,
    serverId: context.server.id,
    capability: context.capability,
    status: 'mapped',
    providerAuthority: context.providerAuthority ?? 1,
    mappingConfidence: 1,
    isDerived: false,
    ordinal,
  };
}

function occurrenceRelationKind(role: LspOccurrenceRole): LspRelationKind {
  switch (role) {
    case 'definition': return LSP_RELATION_KIND.DefinitionOf;
    case 'type_definition': return LSP_RELATION_KIND.TypeDefinitionOf;
    case 'declaration': return LSP_RELATION_KIND.DeclarationOf;
    case 'reference': return LSP_RELATION_KIND.ReferenceTo;
    case 'implementation': return LSP_RELATION_KIND.ImplementationLocationOf;
    case 'type_super':
    case 'type_sub': return LSP_RELATION_KIND.TypeHierarchyLocationOf;
  }
}

function requireKindName(kind: number): LspSymbolKindName {
  const name = symbolKindName(kind);
  if (name === 'Unknown') throw new Error(`Cannot ingest unknown LSP SymbolKind ${kind}`);
  return name;
}

export function rangeKey(range: LspRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

export function stableId(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}
