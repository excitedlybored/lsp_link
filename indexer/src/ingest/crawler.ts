import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  LSP_RELATION_KIND,
  symbolKindName,
  symbolNodeTable,
  type LspAnalysisRun,
  type LspBuildRoot,
  type LspCoverage,
  type LspDiagnostic,
  type LspDocument,
  type LspHover,
  type LspOccurrenceRole,
  type LspPosition,
  type LspRange,
  type LspRelation,
  type LspSemanticToken,
  type LspServer,
  type LspSignature,
  type LspSignatureHelp,
  type LspParameter,
  type LspSymbol,
} from '../model.js';
import { codeOriginForDocumentOrigin } from '../code-origin.js';
import {
  ingestCalls,
  ingestDocumentSymbols,
  ingestOccurrence,
  ingestRun,
  makeMappedSymbolRelation,
  materializeSymbol,
  rangeKey,
  stableId,
  type DocumentSymbolObservation,
  type IngestionContext,
} from './builders.js';
import {
  appendObservationBatch,
  dedupeObservationBatch,
  emptyObservationBatch,
  mergeObservationBatches,
  type LspObservationBatch,
} from './batch.js';
import { LSP_KG_CAPABILITIES } from './collector.js';
import {
  ReferenceCoverageIndex,
  planSemanticTokenPosition,
  type CrawlPlannerDecision,
  type CrawlPlannerMode,
} from './crawl-planner.js';
import type { CrawlProfile } from './crawl-profile.js';

export interface RawCallHierarchyItem extends DocumentSymbolObservation {
  uri: string;
  containerName?: string;
  data?: unknown;
}

export interface RawOutgoingCall {
  to: RawCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface RawIncomingCall {
  from: RawCallHierarchyItem;
  fromRanges: LspRange[];
}

/** Structural subset of ILspAdapter; the crawler does not depend on GitNexus graph classes. */
export interface CompleteCrawlAdapter {
  readonly id: string;
  getServerCapabilities(): Record<string, unknown>;
  documentUri(filePath: string): string;
  openDocument(filePath: string): Promise<void>;
  closeDocument(filePath: string): Promise<void>;
  documentSymbols(filePath: string): Promise<DocumentSymbolObservation[]>;
  prepareCallHierarchy(filePath: string, line: number, character: number): Promise<RawCallHierarchyItem[]>;
  getOutgoingCalls(item: RawCallHierarchyItem): Promise<RawOutgoingCall[]>;
  getIncomingCalls(item: RawCallHierarchyItem): Promise<RawIncomingCall[]>;
  request<T>(method: string, params: unknown): Promise<T>;
  takeNotifications<T>(method: string): T[];
}

export interface CompleteCrawlInput {
  run: LspAnalysisRun;
  server: LspServer;
  buildRoot: LspBuildRoot;
  documents: LspDocument[];
  adapter: CompleteCrawlAdapter;
  repositoryPath: string;
  plannerMode?: CrawlPlannerMode;
  profile?: CrawlProfile;
  onPlannerDecision?: (decision: CrawlPlannerDecision) => void;
  onProgress?: (progress: CrawlProgress) => void;
}

export interface CrawlProgress {
  buildRootId: string;
  pass: 'document-symbols' | 'symbol-references' | 'document-facts';
  completed: number;
  total: number;
  elapsedMs: number;
  ratePerSecond: number;
}

interface RawLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
  originSelectionRange?: LspRange;
}

interface RawDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  codeDescription?: { href?: string };
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: unknown[];
}

interface RawSignatureHelp {
  activeSignature?: number;
  activeParameter?: number;
  signatures: Array<{
    label: string;
    documentation?: unknown;
    activeParameter?: number;
    parameters?: Array<{ label: string | [number, number]; documentation?: unknown }>;
  }>;
}

interface CoverageState {
  capability: string;
  supported: boolean;
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
  consecutiveTimeoutCount: number;
}

interface ObservationCounts {
  resultCount: number;
  mappedCount?: number;
  externalCount?: number;
  unmappedCount?: number;
}

const CALLABLE_KINDS = new Set([6, 9, 12]);
const TYPE_KINDS = new Set([5, 10, 11, 23]);
// JDT rejects typeDefinition at callable declaration names. Type and
// value-bearing DocumentSymbol kinds have a meaningful declared type.
const TYPE_DEFINITION_KINDS = new Set([5, 7, 8, 10, 11, 13, 14, 20, 21, 22, 23, 26]);
const NON_IDENTIFIER_TOKEN_TYPES = new Set([
  'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator',
]);
const VALUE_TOKEN_TYPES = new Set(['parameter', 'variable', 'property', 'enumMember']);
const IMPLEMENTABLE_TOKEN_TYPES = new Set(['class', 'interface', 'type', 'method']);
const CORE_CAPABILITIES = new Set(['textDocument/documentSymbol']);

/**
 * Complete protocol crawl for one build root. It never consults a parser graph
 * nodes and never projects directly into legacy CodeRelation rows.
 */
export async function crawlLspBuildRoot(input: CompleteCrawlInput): Promise<LspObservationBatch> {
  const { run, server, buildRoot, documents, adapter, repositoryPath } = input;
  const plannerMode = input.plannerMode ?? 'legacy';
  const profile = input.profile ?? 'exhaustive';
  const plannerStats = { queried: 0, covered: 0 };
  const recordPlannerDecision = (decision: CrawlPlannerDecision): void => {
    plannerStats[decision.action === 'query' ? 'queried' : 'covered'] += 1;
    input.onPlannerDecision?.(decision);
  };
  const capabilities = adapter.getServerCapabilities();
  const support = detectCapabilitySupport(capabilities);
  const coverage = new Map<string, CoverageState>();
  for (const capability of LSP_KG_CAPABILITIES) {
    coverage.set(capability, createCoverageState(capability, support.get(capability) ?? false));
  }
  if (profile === 'core') {
    for (const capability of LSP_KG_CAPABILITIES) {
      if (!CORE_CAPABILITIES.has(capability)) {
        markCoverageExcluded(coverage, capability,
          'core crawl profile relies on Bazel and bytecode evidence for optional semantic relationships');
      }
    }
  }

  // Delta/range semantic tokens are update/partial variants, not additional
  // semantic facts in a cold snapshot. Their explicit exclusion keeps the
  // completeness ledger honest without duplicating the full-token stream.
  markCoverageExcluded(coverage, 'textDocument/semanticTokens/full/delta',
    'cold snapshot uses textDocument/semanticTokens/full; no prior resultId exists');
  markCoverageExcluded(coverage, 'textDocument/semanticTokens/range',
    'full-document semantic tokens are requested for every opened document');
  markCoverageExcluded(coverage, 'workspace/diagnostic',
    'document diagnostics are crawled per owned document for build-root isolation');

  let batch = ingestRun(run, [server], documents, [buildRoot]);
  const registry = new SymbolRegistry(repositoryPath, run, server, buildRoot, batch);
  const symbolsByDocument = new Map<string, LspSymbol[]>();

  // Pass 1: JDT LS itself defines every source symbol and hierarchy.
  const documentSymbolProgress = progressReporter(input, 'document-symbols', documents.length);
  for (const [documentIndex, document] of documents.entries()) {
    const filePath = requireFilePath(document);
    await observeCapability(coverage, 'textDocument/documentSymbol', async () => {
      await adapter.openDocument(filePath);
      document.wasOpened = true;
      try {
        const observations = await adapter.documentSymbols(filePath);
        const context = createIngestionContext(run, server, document, 'textDocument/documentSymbol');
        const observed = ingestDocumentSymbols(context, observations);
        registry.addBatch(observed);
        symbolsByDocument.set(document.id, observed.symbols);
        appendObservationBatch(batch, observed);
        return countObservations(observed);
      } finally {
        await adapter.closeDocument(filePath);
      }
    });
    documentSymbolProgress(documentIndex + 1);
  }

  // Run/build-root/document provenance is emitted after didOpen outcomes are known.
  appendObservationBatch(batch, ingestRun(run, [server], documents, [buildRoot]));

  // Pass 2: every discovered symbol receives every eligible semantic request.
  // In facts-first mode this phase completes across the root before token gap
  // filling, so references from declarations in later documents can cover
  // occurrences in earlier documents.
  const symbolReferenceProgress = progressReporter(input, 'symbol-references', documents.length);
  for (const [documentIndex, document] of (profile === 'exhaustive' ? documents : []).entries()) {
    const filePath = requireFilePath(document);
    const symbols = symbolsByDocument.get(document.id) ?? [];
    await adapter.openDocument(filePath);
    try {
      for (const symbol of symbols) {
        const position = symbol.selectionRange.start;
        if (profile === 'exhaustive') {
          await collectSymbolLocations(adapter, registry, coverage, batch, run, server, document, symbol,
            filePath, position, 'textDocument/definition', 'definition');
          await collectSymbolLocations(adapter, registry, coverage, batch, run, server, document, symbol,
            filePath, position, 'textDocument/declaration', 'declaration');
        }
        if (profile === 'exhaustive' && TYPE_DEFINITION_KINDS.has(symbol.kind)) {
          await collectSymbolLocations(adapter, registry, coverage, batch, run, server, document, symbol,
            filePath, position, 'textDocument/typeDefinition', 'type_definition');
        }
        await collectSymbolLocations(adapter, registry, coverage, batch, run, server, document, symbol,
          filePath, position, 'textDocument/references', 'reference', { includeDeclaration: true });
        if (profile === 'exhaustive') {
          await collectSymbolLocations(adapter, registry, coverage, batch, run, server, document, symbol,
            filePath, position, 'textDocument/implementation', 'implementation', undefined, true);
          await collectSymbolHover(adapter, coverage, batch, run, server, document, symbol, filePath, position);
        }

        if (profile === 'exhaustive' && CALLABLE_KINDS.has(symbol.kind)) {
          await collectCallHierarchy(adapter, registry, coverage, batch, run, server, document, symbol, filePath, 'outgoing');
          await collectCallHierarchy(adapter, registry, coverage, batch, run, server, document, symbol, filePath, 'incoming');
        }
        if (profile === 'exhaustive' && TYPE_KINDS.has(symbol.kind)) {
          await collectTypeHierarchy(adapter, registry, coverage, batch, run, server, document, symbol, filePath, 'supertypes');
          await collectTypeHierarchy(adapter, registry, coverage, batch, run, server, document, symbol, filePath, 'subtypes');
        }
      }

      if (profile === 'exhaustive' && plannerMode === 'legacy') {
        await collectDocumentFacts(
          adapter, registry, coverage, batch, run, server, document, filePath, symbols,
          capabilities, plannerMode, new ReferenceCoverageIndex(batch.occurrences), recordPlannerDecision,
        );
      }
    } finally {
      await adapter.closeDocument(filePath);
    }
    symbolReferenceProgress(documentIndex + 1);
  }

  if (profile === 'exhaustive' && plannerMode === 'facts-first') {
    const referenceCoverage = new ReferenceCoverageIndex(batch.occurrences);
    const documentFactsProgress = progressReporter(input, 'document-facts', documents.length);
    for (const [documentIndex, document] of documents.entries()) {
      const filePath = requireFilePath(document);
      const symbols = symbolsByDocument.get(document.id) ?? [];
      await adapter.openDocument(filePath);
      try {
        await collectDocumentFacts(
          adapter, registry, coverage, batch, run, server, document, filePath, symbols,
          capabilities, plannerMode, referenceCoverage, recordPlannerDecision,
        );
      } finally {
        await adapter.closeDocument(filePath);
      }
      documentFactsProgress(documentIndex + 1);
    }
  }

  appendObservationBatch(batch, registry.takeMaterializedBatch());
  const coverageBatch = buildCoverageBatch(run, server, coverage);
  if (profile === 'exhaustive' && plannerMode === 'facts-first') {
    console.log(
      `[${buildRoot.id}] facts-first token plan: ${plannerStats.covered} covered by references, `
      + `${plannerStats.queried} unresolved positions queried`,
    );
  }
  appendObservationBatch(batch, coverageBatch);
  return dedupeObservationBatch(batch);
}

async function collectDocumentFacts(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  filePath: string,
  symbols: LspSymbol[],
  capabilities: Record<string, unknown>,
  plannerMode: CrawlPlannerMode,
  referenceCoverage: ReferenceCoverageIndex,
  onPlannerDecision?: (decision: CrawlPlannerDecision) => void,
): Promise<void> {
  await collectDocumentSemanticTokens(adapter, registry, coverage, batch, run, server, document, capabilities);
  await collectSemanticTokenPositionRelations(
    adapter, registry, coverage, batch, run, server, document, filePath, symbols,
    plannerMode, referenceCoverage, onPlannerDecision,
  );
  await collectSignatureHelp(adapter, coverage, batch, run, server, document, filePath);
  await collectDocumentDiagnostics(adapter, coverage, batch, run, server, document);
  collectPublishedDiagnostics(adapter, coverage, batch, run, server, document);
}

async function collectSymbolLocations(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  source: LspSymbol,
  filePath: string,
  position: LspPosition,
  capability: string,
  role: LspOccurrenceRole,
  context?: unknown,
  emitImplementationRelation = false,
): Promise<void> {
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<unknown>(capability, {
      textDocument: { uri: adapter.documentUri(filePath) }, position,
      ...(context === undefined ? {} : { context }),
    });
    const locations = normalizeLocations(raw);
    let mapped = 0;
    for (const [ordinal, location] of locations.entries()) {
      // Reference locations are occurrences *of the requested symbol*; their
      // ranges normally sit inside an unrelated enclosing method and must not
      // be remapped to that enclosing declaration. Definition-like locations
      // instead identify a target declaration and are resolved by range.
      const target = role === 'reference'
        ? source
        : registry.find(location.uri, location.selectionRange ?? location.range);
      const occurrenceDocument = registry.documentForUri(location.uri)
        ?? registry.ensureDocument(location.uri);
      const occurrence = ingestOccurrence(
        createIngestionContext(run, server, occurrenceDocument, capability),
        {
          id: stableId('occurrence', run.id, server.id, capability, source.id,
            location.uri, rangeKey(location.range), String(ordinal)),
          requestUri: document.uri,
          requestPosition: position,
          uri: location.uri,
          range: location.range,
          selectionRange: location.selectionRange,
          originUri: location.originRange ? document.uri : undefined,
          originRange: location.originRange,
          role,
          status: target ? 'mapped' : 'unmapped',
        },
        target,
      );
      appendObservationBatch(batch, occurrence);
      if (target) {
        mapped += 1;
        if (emitImplementationRelation) {
          batch.relations.push(makeMappedSymbolRelation(
            createIngestionContext(run, server, document, capability), target, source, 'implementation',
          ));
        }
      }
    }
    return { resultCount: locations.length, mappedCount: mapped, unmappedCount: locations.length - mapped };
  });
}

async function collectCallHierarchy(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  source: LspSymbol,
  filePath: string,
  direction: 'incoming' | 'outgoing',
): Promise<void> {
  const capability = `callHierarchy/${direction}Calls`;
  await observeCapability(coverage, capability, async () => {
    const prepared = await adapter.prepareCallHierarchy(
      filePath, source.selectionRange.start.line, source.selectionRange.start.character,
    );
    if (prepared.length === 0) return { resultCount: 0 };
    const calls = direction === 'outgoing'
      ? await adapter.getOutgoingCalls(prepared[0])
      : await adapter.getIncomingCalls(prepared[0]);
    const normalized = [];
    let external = 0;
    for (const call of calls) {
      const item = direction === 'outgoing'
        ? (call as RawOutgoingCall).to
        : (call as RawIncomingCall).from;
      const target = registry.findOrMaterializeItem(item);
      if (target.isExternal) external += 1;
      normalized.push(direction === 'outgoing'
        ? { caller: source, target, fromRanges: call.fromRanges }
        : { caller: target, target: source, fromRanges: call.fromRanges });
    }
    const observed = ingestCalls(
      createIngestionContext(run, server, document, capability), direction, normalized,
    );
    appendObservationBatch(batch, observed);
    return { resultCount: observed.callSites.length, mappedCount: observed.callSites.length, externalCount: external };
  });
}

async function collectTypeHierarchy(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  source: LspSymbol,
  filePath: string,
  direction: 'supertypes' | 'subtypes',
): Promise<void> {
  const capability = `typeHierarchy/${direction}`;
  await observeCapability(coverage, capability, async () => {
    const prepared = await adapter.request<RawCallHierarchyItem[] | null>('textDocument/prepareTypeHierarchy', {
      textDocument: { uri: adapter.documentUri(filePath) }, position: source.selectionRange.start,
    });
    if (!prepared?.length) return { resultCount: 0 };
    const items = await adapter.request<RawCallHierarchyItem[] | null>(capability, { item: prepared[0] });
    let external = 0;
    for (const [ordinal, item] of (items ?? []).entries()) {
      const related = registry.findOrMaterializeItem(item);
      if (related.isExternal) external += 1;
      batch.relations.push(direction === 'supertypes'
        ? makeMappedSymbolRelation(createIngestionContext(run, server, document, capability), source, related, 'type_super')
        : makeMappedSymbolRelation(createIngestionContext(run, server, document, capability), related, source, 'type_super'));
      const occurrenceDocument = registry.documentForUri(item.uri) ?? document;
      appendObservationBatch(batch, ingestOccurrence(
        createIngestionContext(run, server, occurrenceDocument, capability),
        {
          id: stableId('occurrence', run.id, server.id, capability, source.id, item.uri,
            rangeKey(item.selectionRange), String(ordinal)),
          requestUri: document.uri,
          requestPosition: source.selectionRange.start,
          uri: item.uri, range: item.range, selectionRange: item.selectionRange,
          role: direction === 'supertypes' ? 'type_super' : 'type_sub', status: 'mapped',
        },
        related,
      ));
    }
    return { resultCount: items?.length ?? 0, mappedCount: items?.length ?? 0, externalCount: external };
  });
}

async function collectSymbolHover(
  adapter: CompleteCrawlAdapter,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  symbol: LspSymbol,
  filePath: string,
  position: LspPosition,
): Promise<void> {
  const capability = 'textDocument/hover';
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<{ contents?: unknown; range?: LspRange } | null>(capability, {
      textDocument: { uri: adapter.documentUri(filePath) }, position,
    });
    if (!raw?.contents) return { resultCount: 0 };
    const hover: LspHover = {
      id: stableId('hover', run.id, server.id, document.id, symbol.id),
      runId: run.id, serverId: server.id, documentId: document.id,
      capability, requestPosition: position, range: raw.range,
      contentFormat: hoverFormat(raw.contents), contents: hoverText(raw.contents), status: 'mapped',
    };
    batch.hovers.push(hover);
    batch.relations.push(
      documentRelation(run, server, document, 'LspHover', hover.id, LSP_RELATION_KIND.HasHover, capability),
      {
        ...documentRelation(run, server, document, symbolNodeTable(symbol.kindName), symbol.id,
          LSP_RELATION_KIND.HoverDescribesSymbol, capability),
        sourceKind: 'LspHover', sourceId: hover.id,
      },
    );
    return { resultCount: 1, mappedCount: 1 };
  });
}

async function collectDocumentSemanticTokens(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  capabilities: Record<string, unknown>,
): Promise<void> {
  const capability = 'textDocument/semanticTokens/full';
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<{ data?: number[] } | null>(capability, {
      textDocument: { uri: document.uri },
    });
    const data = raw?.data ?? [];
    const legend = semanticTokenLegend(capabilities);
    let line = 0;
    let character = 0;
    let mappedCount = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      line += data[i];
      character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
      const token: LspSemanticToken = {
        id: stableId('semantic-token', run.id, server.id, document.id, String(line), String(character), String(i)),
        runId: run.id, serverId: server.id, documentId: document.id, capability,
        line, character, length: data[i + 2],
        tokenType: legend.tokenTypes[data[i + 3]] ?? `unknown:${data[i + 3]}`,
        tokenModifiers: decodeModifiers(data[i + 4], legend.tokenModifiers), status: 'observed',
      };
      batch.semanticTokens.push(token);
      batch.relations.push(documentRelation(
        run, server, document, 'LspSemanticToken', token.id, LSP_RELATION_KIND.HasSemanticToken, capability,
      ));
      const symbol = registry.findContaining(document.uri, line, character);
      if (symbol) {
        batch.relations.push({
          ...documentRelation(run, server, document, symbolNodeTable(symbol.kindName), symbol.id,
            LSP_RELATION_KIND.SemanticTokenDescribesSymbol, capability),
          sourceKind: 'LspSemanticToken', sourceId: token.id, status: 'mapped',
        });
        token.status = 'mapped';
        mappedCount += 1;
      }
    }
    return {
      resultCount: batch.semanticTokens.filter((token) => token.documentId === document.id).length,
      mappedCount,
    };
  });
}

async function collectSignatureHelp(
  adapter: CompleteCrawlAdapter,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  filePath: string,
): Promise<void> {
  const capability = 'textDocument/signatureHelp';
  for (const position of javaSignatureHelpPositions(fs.readFileSync(filePath, 'utf8'))) {
    await observeCapability(coverage, capability, async () => {
      const raw = await adapter.request<RawSignatureHelp | null>(capability, {
        textDocument: { uri: document.uri }, position,
      });
      if (!raw?.signatures?.length) return { resultCount: 0 };

      const help: LspSignatureHelp = {
        id: stableId('signature-help', run.id, server.id, document.id,
          String(position.line), String(position.character)),
        runId: run.id, serverId: server.id, documentId: document.id, capability,
        requestPosition: position,
        activeSignature: raw.activeSignature,
        activeParameter: raw.activeParameter,
        status: 'observed',
      };
      batch.signatureHelps.push(help);
      batch.relations.push(documentRelation(
        run, server, document, 'LspSignatureHelp', help.id,
        LSP_RELATION_KIND.HasSignatureHelp, capability,
      ));

      for (const [signatureOrdinal, rawSignature] of raw.signatures.entries()) {
        const signature: LspSignature = {
          id: stableId('signature', help.id, String(signatureOrdinal), rawSignature.label),
          signatureHelpId: help.id,
          label: rawSignature.label,
          documentation: documentationText(rawSignature.documentation),
          activeParameter: rawSignature.activeParameter,
          ordinal: signatureOrdinal,
        };
        batch.signatures.push(signature);
        batch.relations.push(childRelation(
          run, server, capability, 'LspSignatureHelp', help.id,
          'LspSignature', signature.id, LSP_RELATION_KIND.HasSignature, signatureOrdinal,
        ));

        for (const [parameterOrdinal, rawParameter] of (rawSignature.parameters ?? []).entries()) {
          const parameter: LspParameter = {
            id: stableId('parameter', signature.id, String(parameterOrdinal)),
            signatureId: signature.id,
            label: Array.isArray(rawParameter.label)
              ? rawSignature.label.slice(rawParameter.label[0], rawParameter.label[1])
              : rawParameter.label,
            labelStart: Array.isArray(rawParameter.label) ? rawParameter.label[0] : undefined,
            labelEnd: Array.isArray(rawParameter.label) ? rawParameter.label[1] : undefined,
            documentation: documentationText(rawParameter.documentation),
            ordinal: parameterOrdinal,
          };
          batch.parameters.push(parameter);
          batch.relations.push(childRelation(
            run, server, capability, 'LspSignature', signature.id,
            'LspParameter', parameter.id, LSP_RELATION_KIND.HasParameter, parameterOrdinal,
          ));
        }
      }
      return { resultCount: 1, mappedCount: 1 };
    });
  }
}

async function collectSemanticTokenPositionRelations(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  filePath: string,
  symbols: LspSymbol[],
  plannerMode: CrawlPlannerMode,
  referenceCoverage: ReferenceCoverageIndex,
  onPlannerDecision?: (decision: CrawlPlannerDecision) => void,
): Promise<void> {
  const declarationPositions = new Set(symbols.map((symbol) =>
    `${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`));
  const seen = new Set<string>();
  const tokens = batch.semanticTokens.filter((token) =>
    token.documentId === document.id && !NON_IDENTIFIER_TOKEN_TYPES.has(token.tokenType));
  for (const token of tokens) {
    const key = `${token.line}:${token.character}`;
    if (seen.has(key) || declarationPositions.has(key)) continue;
    seen.add(key);
    const decision = planSemanticTokenPosition({
      mode: plannerMode, documentUri: document.uri, token, referenceCoverage,
    });
    onPlannerDecision?.(decision);
    if (decision.action === 'covered') continue;
    const position = { line: token.line, character: token.character };
    await collectPositionLocations(adapter, registry, coverage, batch, run, server, document,
      filePath, position, 'textDocument/definition', 'definition');
    await collectPositionLocations(adapter, registry, coverage, batch, run, server, document,
      filePath, position, 'textDocument/declaration', 'declaration');
    if (VALUE_TOKEN_TYPES.has(token.tokenType)) {
      await collectPositionLocations(adapter, registry, coverage, batch, run, server, document,
        filePath, position, 'textDocument/typeDefinition', 'type_definition');
    }
    if (IMPLEMENTABLE_TOKEN_TYPES.has(token.tokenType)) {
      await collectPositionLocations(adapter, registry, coverage, batch, run, server, document,
        filePath, position, 'textDocument/implementation', 'implementation');
    }
    await collectPositionHover(adapter, coverage, batch, run, server, document, filePath, position);
  }
}

async function collectPositionLocations(
  adapter: CompleteCrawlAdapter,
  registry: SymbolRegistry,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  filePath: string,
  position: LspPosition,
  capability: string,
  role: LspOccurrenceRole,
): Promise<void> {
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<unknown>(capability, {
      textDocument: { uri: adapter.documentUri(filePath) }, position,
    });
    const locations = normalizeLocations(raw);
    let mapped = 0;
    for (const [ordinal, location] of locations.entries()) {
      const target = registry.find(location.uri, location.selectionRange ?? location.range);
      if (target) mapped += 1;
      const occurrenceDocument = registry.documentForUri(location.uri) ?? registry.ensureDocument(location.uri);
      appendObservationBatch(batch, ingestOccurrence(
        createIngestionContext(run, server, occurrenceDocument, capability),
        {
          id: stableId('occurrence', run.id, server.id, capability, document.uri,
            `${position.line}:${position.character}`, location.uri, rangeKey(location.range), String(ordinal)),
          requestUri: document.uri, requestPosition: position,
          uri: location.uri, range: location.range, selectionRange: location.selectionRange,
          originUri: location.originRange ? document.uri : undefined,
          originRange: location.originRange, role, status: target ? 'mapped' : 'unmapped',
        },
        target,
      ));
    }
    return { resultCount: locations.length, mappedCount: mapped, unmappedCount: locations.length - mapped };
  });
}

async function collectPositionHover(
  adapter: CompleteCrawlAdapter,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  filePath: string,
  position: LspPosition,
): Promise<void> {
  const capability = 'textDocument/hover';
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<{ contents?: unknown; range?: LspRange } | null>(capability, {
      textDocument: { uri: adapter.documentUri(filePath) }, position,
    });
    if (!raw?.contents) return { resultCount: 0 };
    const hover: LspHover = {
      id: stableId('hover', run.id, server.id, document.id, `${position.line}:${position.character}`),
      runId: run.id, serverId: server.id, documentId: document.id, capability,
      requestPosition: position, range: raw.range,
      contentFormat: hoverFormat(raw.contents), contents: hoverText(raw.contents), status: 'observed',
    };
    batch.hovers.push(hover);
    batch.relations.push(documentRelation(
      run, server, document, 'LspHover', hover.id, LSP_RELATION_KIND.HasHover, capability,
    ));
    return { resultCount: 1, mappedCount: 1 };
  });
}

async function collectDocumentDiagnostics(
  adapter: CompleteCrawlAdapter,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
): Promise<void> {
  const capability = 'textDocument/diagnostic';
  await observeCapability(coverage, capability, async () => {
    const raw = await adapter.request<{ items?: RawDiagnostic[] } | null>(capability, {
      textDocument: { uri: document.uri },
    });
    const diagnostics = appendDiagnostics(run, server, document, capability, raw?.items ?? [], batch);
    return { resultCount: diagnostics };
  });
}

function collectPublishedDiagnostics(
  adapter: CompleteCrawlAdapter,
  coverage: Map<string, CoverageState>,
  batch: LspObservationBatch,
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
): void {
  const capability = 'textDocument/publishDiagnostics';
  const state = getCoverageState(coverage, capability);
  state.eligibleCount += 1;
  state.attemptedCount += 1;
  const notifications = adapter.takeNotifications<{ uri?: string; diagnostics?: RawDiagnostic[] }>(capability);
  const matching = notifications.filter((notification) => !notification.uri || notification.uri === document.uri);
  const count = matching.reduce((total, notification) =>
    total + appendDiagnostics(run, server, document, capability, notification.diagnostics ?? [], batch), 0);
  state.successCount += 1;
  state.resultCount += count;
  if (count === 0) state.emptyCount += 1;
}

function appendDiagnostics(
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  capability: 'textDocument/publishDiagnostics' | 'textDocument/diagnostic',
  values: RawDiagnostic[],
  batch: LspObservationBatch,
): number {
  for (const [ordinal, value] of values.entries()) {
    const diagnostic: LspDiagnostic = {
      id: stableId('diagnostic', run.id, server.id, document.id, capability,
        rangeKey(value.range), String(value.code ?? ''), String(ordinal)),
      runId: run.id, serverId: server.id, documentId: document.id, capability,
      status: 'observed', range: value.range, severity: value.severity,
      code: value.code === undefined ? undefined : String(value.code),
      codeHref: value.codeDescription?.href, source: value.source, message: value.message,
      tags: value.tags ?? [],
      relatedInformationJson: value.relatedInformation === undefined
        ? undefined : JSON.stringify(value.relatedInformation),
    };
    batch.diagnostics.push(diagnostic);
    batch.relations.push(documentRelation(
      run, server, document, 'LspDiagnostic', diagnostic.id, LSP_RELATION_KIND.HasDiagnostic, capability,
    ));
  }
  return values.length;
}

class SymbolRegistry {
  private readonly symbolsByUri = new Map<string, LspSymbol[]>();
  private readonly documents = new Map<string, LspDocument>();
  private readonly pending = emptyObservationBatch();

  constructor(
    private readonly repositoryPath: string,
    private readonly run: LspAnalysisRun,
    private readonly server: LspServer,
    private readonly buildRoot: LspBuildRoot,
    seed: LspObservationBatch,
  ) {
    for (const document of seed.documents) this.documents.set(document.uri, document);
    for (const symbol of seed.symbols) this.addSymbol(symbol);
  }

  addBatch(batch: LspObservationBatch): void {
    for (const document of batch.documents) this.documents.set(document.uri, document);
    for (const symbol of batch.symbols) this.addSymbol(symbol);
  }

  find(uri: string, range: LspRange): LspSymbol | undefined {
    const candidates = this.symbolsByUri.get(uri) ?? [];
    const exact = candidates.find((symbol) => rangeKey(symbol.selectionRange) === rangeKey(range));
    if (exact) return exact;
    return candidates
      .filter((symbol) => rangeContains(symbol.range, range))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
  }

  findContaining(uri: string, line: number, character: number): LspSymbol | undefined {
    return (this.symbolsByUri.get(uri) ?? [])
      .filter((symbol) => positionInRange({ line, character }, symbol.range))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
  }

  findOrMaterializeItem(item: RawCallHierarchyItem): LspSymbol {
    const existing = this.find(item.uri, item.selectionRange);
    if (existing) return existing;
    const document = this.ensureDocument(item.uri);
    const kindName = symbolKindName(item.kind);
    if (kindName === 'Unknown') throw new Error(`Unknown LSP SymbolKind ${item.kind} for ${item.name}`);
    const symbol = materializeSymbol(document, item, kindName);
    this.addSymbol(symbol);
    this.pending.symbols.push(symbol);
    return symbol;
  }

  documentForUri(uri: string): LspDocument | undefined { return this.documents.get(uri); }

  private addSymbol(symbol: LspSymbol): void {
    const symbols = this.symbolsByUri.get(symbol.uri) ?? [];
    symbols.push(symbol);
    this.symbolsByUri.set(symbol.uri, symbols);
  }

  takeMaterializedBatch(): LspObservationBatch { return this.pending; }

  ensureDocument(uri: string): LspDocument {
    const existing = this.documents.get(uri);
    if (existing) return existing;
    const filePath = uri.startsWith('file://') ? safeFilePath(uri) : undefined;
    const insideRepository = filePath ? isInside(this.repositoryPath, filePath) : false;
    const origin = insideRepository ? 'generated' : classifyExternalOrigin(uri);
    const document: LspDocument = {
      id: stableId('document', uri), uri, filePath, languageId: 'java',
      origin, codeOrigin: codeOriginForDocumentOrigin(origin),
      wasOpened: false,
      buildRootId: insideRepository ? this.buildRoot.id : undefined,
    };
    this.documents.set(uri, document);
    this.pending.documents.push(document);
    return document;
  }
}

async function observeCapability(
  coverage: Map<string, CoverageState>,
  capability: string,
  execute: () => Promise<ObservationCounts>,
): Promise<void> {
  const state = getCoverageState(coverage, capability);
  state.eligibleCount += 1;
  if (!state.supported || state.exclusionReason) return;
  state.attemptedCount += 1;
  try {
    const result = await execute();
    state.consecutiveTimeoutCount = 0;
    state.successCount += 1;
    state.resultCount += result.resultCount;
    state.mappedCount += result.mappedCount ?? 0;
    state.externalCount += result.externalCount ?? 0;
    state.unmappedCount += result.unmappedCount ?? 0;
    if (result.resultCount === 0) state.emptyCount += 1;
  } catch (error) {
    if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
      state.timeoutCount += 1;
      state.consecutiveTimeoutCount += 1;
    } else {
      state.failureCount += 1;
      state.consecutiveTimeoutCount = 0;
    }
    const failed = state.failureCount + state.timeoutCount;
    if (state.consecutiveTimeoutCount >= 3
      || (state.attemptedCount >= 20 && failed / state.attemptedCount >= 0.25)) {
      state.exclusionReason = `capability circuit breaker opened after ${state.attemptedCount} attempts `
        + `(${state.timeoutCount} timeouts, ${state.failureCount} failures)`;
    }
  }
}

function buildCoverageBatch(
  run: LspAnalysisRun,
  server: LspServer,
  states: Map<string, CoverageState>,
): LspObservationBatch {
  const batch = emptyObservationBatch();
  for (const [ordinal, state] of [...states.values()].entries()) {
    const status = determineCoverageStatus(state);
    const value: LspCoverage = {
      id: stableId('coverage', run.id, server.id, state.capability),
      runId: run.id, serverId: server.id, languageId: server.languageId,
      capability: state.capability, status,
      eligibleCount: state.eligibleCount, attemptedCount: state.attemptedCount,
      successCount: state.successCount, emptyCount: state.emptyCount,
      failureCount: state.failureCount, timeoutCount: state.timeoutCount,
      resultCount: state.resultCount, mappedCount: state.mappedCount,
      externalCount: state.externalCount, unmappedCount: state.unmappedCount,
      exclusionReason: state.exclusionReason,
    };
    batch.coverage.push(value);
    batch.relations.push({
      id: stableId('relation', value.id, LSP_RELATION_KIND.ReportsCoverage),
      sourceKind: 'LspServer', sourceId: server.id,
      targetKind: 'LspCoverage', targetId: value.id,
      kind: LSP_RELATION_KIND.ReportsCoverage, runId: run.id, serverId: server.id,
      capability: state.capability, status, providerAuthority: 1,
      mappingConfidence: 1, isDerived: false, ordinal,
    });
  }
  return batch;
}

function detectCapabilitySupport(capabilities: Record<string, unknown>): Map<string, boolean> {
  const present = (key: string): boolean => Boolean(capabilities[key]);
  const registrations = (capabilities.__dynamicRegistrations as Array<{ method?: string }> | undefined) ?? [];
  const registered = (method: string): boolean => registrations.some((value) => value.method === method);
  const semantic = capabilities.semanticTokensProvider as { full?: unknown; range?: unknown; legend?: unknown } | undefined;
  return new Map<string, boolean>([
    ['textDocument/documentSymbol', present('documentSymbolProvider') || registered('textDocument/documentSymbol')],
    ['callHierarchy/outgoingCalls', present('callHierarchyProvider') || registered('textDocument/prepareCallHierarchy')],
    ['callHierarchy/incomingCalls', present('callHierarchyProvider') || registered('textDocument/prepareCallHierarchy')],
    ['textDocument/definition', present('definitionProvider') || registered('textDocument/definition')],
    ['textDocument/declaration', present('declarationProvider') || registered('textDocument/declaration')],
    ['textDocument/typeDefinition', present('typeDefinitionProvider') || registered('textDocument/typeDefinition')],
    ['textDocument/references', present('referencesProvider') || registered('textDocument/references')],
    ['textDocument/implementation', present('implementationProvider') || registered('textDocument/implementation')],
    ['typeHierarchy/supertypes', present('typeHierarchyProvider') || registered('textDocument/prepareTypeHierarchy')],
    ['typeHierarchy/subtypes', present('typeHierarchyProvider') || registered('textDocument/prepareTypeHierarchy')],
    ['textDocument/hover', present('hoverProvider') || registered('textDocument/hover')],
    // publishDiagnostics is a server notification and has no initialize capability bit.
    ['textDocument/publishDiagnostics', true],
    ['textDocument/diagnostic', present('diagnosticProvider') || registered('textDocument/diagnostic')],
    ['workspace/diagnostic', present('diagnosticProvider') || registered('workspace/diagnostic')],
    ['textDocument/semanticTokens/full', Boolean(semantic?.full)],
    ['textDocument/semanticTokens/full/delta', Boolean(
      semantic?.full && typeof semantic.full === 'object' && (semantic.full as { delta?: unknown }).delta,
    )],
    ['textDocument/semanticTokens/range', Boolean(semantic?.range)],
    ['textDocument/signatureHelp', present('signatureHelpProvider') || registered('textDocument/signatureHelp')],
  ]);
}

function normalizeLocations(raw: unknown): Array<{
  uri: string; range: LspRange; selectionRange?: LspRange; originRange?: LspRange;
}> {
  const values = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const normalized = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const location = value as RawLocation;
    const uri = location.targetUri ?? location.uri;
    const range = location.targetRange ?? location.range;
    if (!uri || !range) continue;
    normalized.push({
      uri, range,
      selectionRange: location.targetSelectionRange,
      originRange: location.originSelectionRange,
    });
  }
  return normalized;
}

function createIngestionContext(
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  capability: string,
): IngestionContext {
  return { runId: run.id, server, document, capability, providerAuthority: 1 };
}

function documentRelation(
  run: LspAnalysisRun,
  server: LspServer,
  document: LspDocument,
  targetKind: LspRelation['targetKind'],
  targetId: string,
  kind: LspRelation['kind'],
  capability: string,
): LspRelation {
  return {
    id: stableId('relation', run.id, server.id, capability, kind, document.id, targetId),
    sourceKind: 'LspDocument', sourceId: document.id, targetKind, targetId, kind,
    runId: run.id, serverId: server.id, capability, status: 'observed',
    providerAuthority: 1, mappingConfidence: 1, isDerived: false,
  };
}

function childRelation(
  run: LspAnalysisRun,
  server: LspServer,
  capability: string,
  sourceKind: LspRelation['sourceKind'],
  sourceId: string,
  targetKind: LspRelation['targetKind'],
  targetId: string,
  kind: LspRelation['kind'],
  ordinal: number,
): LspRelation {
  return {
    id: stableId('relation', run.id, server.id, capability, kind, sourceId, targetId),
    sourceKind, sourceId, targetKind, targetId, kind,
    runId: run.id, serverId: server.id, capability, status: 'observed',
    providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
  };
}

function documentationText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}

/**
 * Finds invocation-context cursors using Java lexical rules only. JavaScript
 * indexes strings in UTF-16 code units, which is also JDT LS's negotiated
 * position encoding, so the emitted character offsets need no conversion.
 */
function javaSignatureHelpPositions(source: string): LspPosition[] {
  const positions: LspPosition[] = [];
  let line = 0;
  let character = 0;
  let state: 'code' | 'line_comment' | 'block_comment' | 'string' | 'character' | 'text_block' = 'code';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    const third = source[index + 2];

    if (state === 'line_comment') {
      if (current === '\n') state = 'code';
    } else if (state === 'block_comment') {
      if (current === '*' && next === '/') {
        index += 1;
        character += 1;
        state = 'code';
      }
    } else if (state === 'text_block') {
      if (current === '"' && next === '"' && third === '"') {
        index += 2;
        character += 2;
        state = 'code';
      }
    } else if (state === 'string' || state === 'character') {
      const delimiter = state === 'string' ? '"' : "'";
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === delimiter) state = 'code';
    } else if (current === '/' && next === '/') {
      index += 1;
      character += 1;
      state = 'line_comment';
    } else if (current === '/' && next === '*') {
      index += 1;
      character += 1;
      state = 'block_comment';
    } else if (current === '"' && next === '"' && third === '"') {
      index += 2;
      character += 2;
      state = 'text_block';
    } else if (current === '"') {
      state = 'string';
    } else if (current === "'") {
      state = 'character';
    } else if (current === '(' || current === ',') {
      positions.push({ line, character: character + 1 });
    }

    if (current === '\n') {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return positions;
}

function countObservations(batch: LspObservationBatch): ObservationCounts {
  return {
    resultCount: batch.symbols.length + batch.callSites.length + batch.occurrences.length +
      batch.diagnostics.length + batch.hovers.length + batch.semanticTokens.length,
    mappedCount: batch.relations.filter((relation) => relation.status === 'mapped').length,
    externalCount: batch.symbols.filter((symbol) => symbol.isExternal).length,
    unmappedCount: batch.occurrences.filter((occurrence) => occurrence.status === 'unmapped').length,
  };
}

function createCoverageState(capability: string, supported: boolean): CoverageState {
  return {
    capability, supported, eligibleCount: 0, attemptedCount: 0, successCount: 0,
    emptyCount: 0, failureCount: 0, timeoutCount: 0, resultCount: 0,
    mappedCount: 0, externalCount: 0, unmappedCount: 0, consecutiveTimeoutCount: 0,
  };
}

function markCoverageExcluded(states: Map<string, CoverageState>, capability: string, reason: string): void {
  getCoverageState(states, capability).exclusionReason = reason;
}

function getCoverageState(states: Map<string, CoverageState>, capability: string): CoverageState {
  const state = states.get(capability);
  if (!state) throw new Error(`Capability ${capability} is absent from the complete inventory`);
  return state;
}

function determineCoverageStatus(state: CoverageState): LspCoverage['status'] {
  if (!state.supported) return 'unsupported';
  if ((state.exclusionReason && state.attemptedCount === 0) || state.eligibleCount === 0) return 'excluded';
  if (state.successCount > 0 && (state.failureCount > 0 || state.timeoutCount > 0)) return 'partial';
  if (state.timeoutCount > 0) return 'timeout';
  if (state.failureCount > 0) return 'failed';
  if (state.resultCount === 0) return 'empty';
  return state.unmappedCount > 0 ? 'unmapped' : state.mappedCount > 0 ? 'mapped' : 'observed';
}

function progressReporter(
  input: CompleteCrawlInput,
  pass: CrawlProgress['pass'],
  total: number,
): (completed: number) => void {
  const startedAt = Date.now();
  let lastReportedAt = 0;
  const interval = Math.max(1, Math.min(100, Math.ceil(total / 100)));
  return (completed: number): void => {
    const now = Date.now();
    if (completed !== total && completed % interval !== 0 && now - lastReportedAt < 15_000) return;
    lastReportedAt = now;
    const elapsedMs = now - startedAt;
    const progress: CrawlProgress = {
      buildRootId: input.buildRoot.id,
      pass,
      completed,
      total,
      elapsedMs,
      ratePerSecond: elapsedMs === 0 ? 0 : completed / (elapsedMs / 1000),
    };
    input.onProgress?.(progress);
    console.log(
      `[${input.buildRoot.id}] ${pass}: ${completed}/${total} `
      + `(${total === 0 ? 100 : Math.floor(completed * 100 / total)}%, ${progress.ratePerSecond.toFixed(2)} docs/s)`,
    );
  };
}

function semanticTokenLegend(capabilities: Record<string, unknown>): {
  tokenTypes: string[]; tokenModifiers: string[];
} {
  const provider = capabilities.semanticTokensProvider as {
    legend?: { tokenTypes?: string[]; tokenModifiers?: string[] };
  } | undefined;
  return {
    tokenTypes: provider?.legend?.tokenTypes ?? [],
    tokenModifiers: provider?.legend?.tokenModifiers ?? [],
  };
}

function decodeModifiers(bits: number, names: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    if ((bits & (1 << index)) !== 0) result.push(names[index]);
  }
  return result;
}

function hoverText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(hoverText).join('\n');
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  if (value && typeof value === 'object' && 'kind' in value && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value ?? '');
}

function hoverFormat(value: unknown): LspHover['contentFormat'] {
  const values = Array.isArray(value) ? value : [value];
  const formats = new Set(values.map((item) =>
    item && typeof item === 'object' && 'kind' in item
      ? String((item as { kind: unknown }).kind)
      : item && typeof item === 'object' && 'language' in item ? 'marked_string' : 'plaintext'));
  if (formats.size > 1) return 'mixed';
  const format = [...formats][0];
  return format === 'markdown' ? 'markdown' : format === 'marked_string' ? 'marked_string' : 'plaintext';
}

function rangeContains(outer: LspRange, inner: LspRange): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(outer.end, inner.end) >= 0;
}

function positionInRange(position: LspPosition, range: LspRange): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function comparePosition(a: LspPosition, b: LspPosition): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeSize(range: LspRange): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}

function classifyExternalOrigin(uri: string): LspDocument['origin'] {
  return /(?:java\/|java\.|jre|jdk)/i.test(uri) ? 'standard_library' : 'dependency';
}

function requireFilePath(document: LspDocument): string {
  if (document.filePath) return document.filePath;
  if (document.uri.startsWith('file://')) return fileURLToPath(document.uri);
  throw new Error(`Workspace document ${document.id} has no file path`);
}

function safeFilePath(uri: string): string | undefined {
  try { return fileURLToPath(uri); } catch { return undefined; }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Helper used by the orchestration CLI to create owned document records. */
export function workspaceDocument(
  filePath: string,
  buildRootId: string,
  origin: LspDocument['origin'] = 'workspace',
): LspDocument {
  const absolute = path.resolve(filePath);
  const uri = pathToFileURL(absolute).href;
  return {
    id: stableId('document', uri), uri, filePath: absolute, languageId: 'java',
    origin, codeOrigin: codeOriginForDocumentOrigin(origin), wasOpened: false, buildRootId,
  };
}
