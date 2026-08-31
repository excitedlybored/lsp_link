import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { CompleteCrawlAdapter } from './crawler.js';
import {
  LSP_RELATION_KIND,
  type LspAnalysisRun,
  type LspBuildRoot,
  type LspCoverage,
  type LspDocument,
  type LspRange,
  type LspRelation,
  type LspServer,
  type LspSymbol,
} from '../model.js';
import { appendObservationBatch, emptyObservationBatch, type LspObservationBatch } from './batch.js';
import { ingestCalls, ingestDocumentSymbols, ingestOccurrence, ingestRun, makeMappedSymbolRelation, stableId } from './builders.js';

const CAPABILITIES = {
  declarations: 'gitnexus.java/batchDeclarations',
  occurrences: 'gitnexus.java/batchOccurrences',
  calls: 'gitnexus.java/batchCalls',
  types: 'gitnexus.java/batchTypes',
} as const;

interface BatchFact {
  kind: 'document' | 'declaration' | 'occurrence' | 'call' | 'typeEdge' | 'summary';
  uri?: string;
  name?: string;
  declarationKind?: string;
  targetKey?: string;
  targetPortableKey?: string;
  sourceKey?: string;
  sourcePortableKey?: string;
  relation?: string;
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  selectionStartLine?: number;
  selectionStartCharacter?: number;
  selectionEndLine?: number;
  selectionEndCharacter?: number;
}

interface BatchCommandResult {
  schemaVersion: number;
  status: string;
  output: string;
  manifest: string;
  sha256: string;
  failedDocuments?: number;
  firstError?: string;
}
type BatchAdapter = CompleteCrawlAdapter & { getSessionMetadata(): { processShardId?: string } };
const collectionByAdapter = new WeakMap<BatchAdapter, Promise<BatchCommandResult>>();

export async function crawlJdtBatchRoot(input: {
  run: LspAnalysisRun;
  server: LspServer;
  buildRoot: LspBuildRoot;
  documents: LspDocument[];
  files: string[];
  adapter: BatchAdapter;
  repositoryPath: string;
}): Promise<LspObservationBatch> {
  const { run, server, buildRoot, documents, files, adapter, repositoryPath } = input;
  const batch = ingestRun(run, [server], documents, [buildRoot]);
  const command = collectionByAdapter.get(adapter) ?? startCollection(adapter, repositoryPath, run.id);
  collectionByAdapter.set(adapter, command);
  let result: BatchCommandResult;
  try {
    result = await command;
    validateResult(result);
  } catch (error) {
    server.status = 'partial';
    server.observationsJson = JSON.stringify({ batchError: error instanceof Error ? error.message : String(error) });
    addCoverage(batch, run, server, documents.length, new Map(), String(error));
    return batch;
  }

  const documentByPath = new Map<string, LspDocument>();
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index]!;
    documentByPath.set(uriPath(document.uri), document);
    documentByPath.set(uriPath(adapter.documentUri(files[index]!)), document);
  }
  const symbolsByPortable = new Map<string, LspSymbol>();
  const fieldsByOwnerAndName = new Map<string, LspSymbol>();
  const symbolsByDocument = new Map<string, LspSymbol[]>();
  const counts = new Map<string, number>();
  for await (const fact of rootFacts(result.output, documentByPath)) {
    if (fact.kind !== 'declaration') continue;
    const document = fact.uri ? documentByPath.get(uriPath(fact.uri)) : undefined;
    if (!document || !fact.name || !fact.targetPortableKey) continue;
    const range = factRange(fact);
    const selectionRange = selectionFactRange(fact);
    const observed = ingestDocumentSymbols(
      { runId: run.id, server, document, capability: CAPABILITIES.declarations },
      [{ name: fact.name, kind: symbolKind(fact.declarationKind), range, selectionRange }],
    );
    const symbol = observed.symbols[0]!;
    symbol.stableKey = fact.targetPortableKey;
    symbolsByPortable.set(fact.targetPortableKey, symbol);
    if (fact.declarationKind === 'field') {
      const separator = fact.targetPortableKey.indexOf('#');
      if (separator > 0) fieldsByOwnerAndName.set(
        `${fact.targetPortableKey.slice(0, separator)}#${fact.name}`, symbol,
      );
    }
    const values = symbolsByDocument.get(document.id) ?? [];
    values.push(symbol); symbolsByDocument.set(document.id, values);
    appendObservationBatch(batch, observed);
    increment(counts, CAPABILITIES.declarations);
  }

  const enclosing = (documentId: string, range: LspRange): LspSymbol | undefined =>
    (symbolsByDocument.get(documentId) ?? [])
      .filter((symbol) => contains(symbol.range, range)
        && (symbol.kindName === 'Method' || symbol.kindName === 'Constructor'))
      .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];

  // A second streaming pass sees the complete declaration identity map without
  // retaining millions of raw facts in Node memory.
  for await (const fact of rootFacts(result.output, documentByPath)) {
    const document = fact.uri ? documentByPath.get(uriPath(fact.uri)) : undefined;
    if (fact.kind === 'occurrence' && document) {
      const range = factRange(fact);
      const target = fact.targetPortableKey
        ? resolveReferenceTarget(fact.targetPortableKey, symbolsByPortable, fieldsByOwnerAndName)
        : undefined;
      appendObservationBatch(batch, ingestOccurrence(
        { runId: run.id, server, document, capability: CAPABILITIES.occurrences },
        {
          id: stableId('batch-occurrence', run.id, server.id, document.id, String(fact.startLine), String(fact.startCharacter), fact.targetPortableKey ?? ''),
          uri: document.uri, range, role: 'reference', status: target ? 'mapped' : 'unmapped',
        },
        target,
      ));
      increment(counts, CAPABILITIES.occurrences);
    } else if (fact.kind === 'call' && document && fact.targetPortableKey) {
      const range = factRange(fact);
      const caller = enclosing(document.id, range);
      const target = symbolsByPortable.get(fact.targetPortableKey);
      if (!caller || !target) continue;
      appendObservationBatch(batch, ingestCalls(
        { runId: run.id, server, document, capability: CAPABILITIES.calls },
        'outgoing', [{ caller, target, fromRanges: [range] }],
      ));
      increment(counts, CAPABILITIES.calls);
    } else if (fact.kind === 'typeEdge' && fact.sourcePortableKey && fact.targetPortableKey) {
      const source = symbolsByPortable.get(fact.sourcePortableKey);
      const target = symbolsByPortable.get(fact.targetPortableKey);
      if (!source || !target) continue;
      const sourceDocument = documents.find((value) => value.id === source.documentId)!;
      batch.relations.push(makeMappedSymbolRelation(
        { runId: run.id, server, document: sourceDocument, capability: CAPABILITIES.types }, source, target,
        fact.relation === 'overrides' ? 'implementation' : 'type_super',
      ));
      increment(counts, CAPABILITIES.types);
    }
  }
  addCoverage(batch, run, server, documents.length, counts);
  server.capabilitiesJson = JSON.stringify({ ...adapter.getServerCapabilities(), gitnexusJavaBatch: { schemaVersion: 1, capabilities: Object.values(CAPABILITIES) } });
  return batch;
}

async function* rootFacts(output: string, documentByPath: Map<string, LspDocument>): AsyncGenerator<BatchFact> {
  const stream = fs.createReadStream(output, { encoding: 'utf8' });
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const fact = JSON.parse(line) as BatchFact;
    if (fact.uri && documentByPath.has(uriPath(fact.uri))) yield fact;
  }
}

function startCollection(adapter: BatchAdapter, repositoryPath: string, runId: string): Promise<BatchCommandResult> {
  const token = createHash('sha256').update(`${runId}\0${adapter.getSessionMetadata().processShardId ?? 'jdt'}`).digest('hex').slice(0, 20);
  const output = path.join(repositoryPath, '.gitnexus', 'jdtls', 'batch-output', `${token}.ndjson`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`[stage:jdt-batch-semantics] collecting shard facts into ${path.basename(output)}`);
  const startedAt = Date.now();
  return adapter.request<BatchCommandResult>('workspace/executeCommand', {
    command: 'gitnexus.java.collectBatch', arguments: [output, 256],
  }).then((result) => {
    console.log(`[jdtls-stage] ${JSON.stringify({
      shardId: adapter.getSessionMetadata().processShardId ?? 'jdt',
      phase: 'batch-ast-collection', status: result.status, elapsedMs: Date.now() - startedAt,
      failedDocuments: result.failedDocuments ?? 0,
    })}`);
    return result;
  });
}

function validateResult(result: BatchCommandResult): void {
  if (result.schemaVersion !== 1 || result.status !== 'complete') throw new Error('JDT batch extension returned an incompatible result');
  const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8')) as BatchCommandResult;
  const actual = createHash('sha256').update(fs.readFileSync(result.output)).digest('hex');
  if (actual !== result.sha256 || manifest.sha256 !== result.sha256) throw new Error('JDT batch output checksum mismatch');
}

function addCoverage(batch: LspObservationBatch, run: LspAnalysisRun, server: LspServer, eligible: number,
  counts: Map<string, number>, error?: string): void {
  for (const [ordinal, capability] of Object.values(CAPABILITIES).entries()) {
    const resultCount = counts.get(capability) ?? 0;
    const coverage: LspCoverage = {
      id: stableId('coverage', run.id, server.id, capability), runId: run.id, serverId: server.id,
      languageId: 'java', capability, status: error ? 'partial' : resultCount > 0 ? 'observed' : 'empty',
      eligibleCount: eligible, attemptedCount: eligible, successCount: error ? 0 : eligible,
      emptyCount: !error && resultCount === 0 ? eligible : 0, failureCount: error ? eligible : 0,
      timeoutCount: 0, resultCount, mappedCount: resultCount, externalCount: 0, unmappedCount: 0,
      exclusionReason: error,
    };
    batch.coverage.push(coverage);
    const relation: LspRelation = {
      id: `${coverage.id}:relation`, sourceKind: 'LspServer', sourceId: server.id,
      targetKind: 'LspCoverage', targetId: coverage.id, kind: LSP_RELATION_KIND.ReportsCoverage,
      runId: run.id, serverId: server.id, capability, status: coverage.status,
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
    };
    batch.relations.push(relation);
  }
}

function factRange(fact: BatchFact): LspRange {
  return { start: { line: fact.startLine ?? 0, character: fact.startCharacter ?? 0 }, end: { line: fact.endLine ?? fact.startLine ?? 0, character: fact.endCharacter ?? fact.startCharacter ?? 0 } };
}
function selectionFactRange(fact: BatchFact): LspRange {
  return {
    start: { line: fact.selectionStartLine ?? fact.startLine ?? 0, character: fact.selectionStartCharacter ?? fact.startCharacter ?? 0 },
    end: { line: fact.selectionEndLine ?? fact.endLine ?? 0, character: fact.selectionEndCharacter ?? fact.endCharacter ?? 0 },
  };
}
function symbolKind(kind?: string): number {
  return kind === 'method' ? 6 : kind === 'constructor' ? 9 : kind === 'interface' ? 11 : kind === 'enum' ? 10
    : kind === 'field' ? 8 : kind === 'parameter' ? 13 : kind === 'variable' ? 13 : kind === 'annotation' ? 11
      : kind === 'package' ? 4 : 5;
}
function uriPath(uri: string): string {
  try { return normalizePath(fileURLToPath(uri)); } catch { return uri; }
}
function normalizePath(value: string): string { const normalized = path.normalize(path.resolve(value)); return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized; }
function increment(counts: Map<string, number>, key: string): void { counts.set(key, (counts.get(key) ?? 0) + 1); }
function resolveReferenceTarget(portableKey: string, symbols: Map<string, LspSymbol>,
  fields: Map<string, LspSymbol>): LspSymbol | undefined {
  const exact = symbols.get(portableKey);
  if (exact) return exact;
  const accessor = /^(T:[^#]+)#(?:get|set|is)([A-Z][^<(]*)\(/.exec(portableKey);
  if (!accessor) return undefined;
  const property = accessor[2]!.length > 1 && /[A-Z]/.test(accessor[2]![1]!)
    ? accessor[2]! : accessor[2]![0]!.toLowerCase() + accessor[2]!.slice(1);
  return fields.get(`${accessor[1]}#${property}`);
}
function contains(outer: LspRange, inner: LspRange): boolean { return compare(outer.start, inner.start) <= 0 && compare(outer.end, inner.end) >= 0; }
function compare(left: {line:number;character:number}, right: {line:number;character:number}): number { return left.line - right.line || left.character - right.character; }
function rangeSize(range: LspRange): number { return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character; }
