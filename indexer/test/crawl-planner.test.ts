import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyObservationBatch } from '../src/ingest/batch.js';
import { materializeSymbol } from '../src/ingest/builders.js';
import { ReferenceCoverageIndex, planSemanticTokenPosition } from '../src/ingest/crawl-planner.js';
import { compareCrawlSemanticInventories, compareRequiredJavaBatchInventories } from '../src/ingest/semantic-inventory.js';
import type { LspOccurrence, LspSemanticToken } from '../src/model.js';

const occurrence: LspOccurrence = {
  id: 'reference:save', runId: 'run', serverId: 'server', documentId: 'document',
  capability: 'textDocument/references', requestUri: 'file:///Service.java',
  requestPosition: { line: 1, character: 7 }, uri: 'file:///Service.java',
  range: { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } },
  role: 'reference', status: 'mapped',
};

const token: LspSemanticToken = {
  id: 'token:save', runId: 'run', serverId: 'server', documentId: 'document',
  capability: 'textDocument/semanticTokens/full', line: 3, character: 4, length: 4,
  tokenType: 'method', tokenModifiers: [], status: 'observed',
};

test('the canonical planner suppresses only token positions covered by mapped references', () => {
  const covered = planSemanticTokenPosition({
    documentUri: occurrence.uri, token,
    referenceCoverage: new ReferenceCoverageIndex([occurrence]),
  });
  assert.equal(covered.action, 'covered');
  assert.equal(covered.reason, 'covered-by-reference');
  assert.deepEqual(covered.coveringEvidenceIds, [occurrence.id]);

  const unresolved = planSemanticTokenPosition({
    documentUri: occurrence.uri, token: { ...token, character: 12 },
    referenceCoverage: new ReferenceCoverageIndex([occurrence]),
  });
  assert.equal(unresolved.action, 'query');
  assert.equal(unresolved.reason, 'unresolved-token');
});

test('batch release gate permits additions but rejects missing required Java facts', () => {
  const exhaustive = emptyObservationBatch();
  const candidate = emptyObservationBatch();
  const document = {
    id: 'document', uri: 'file:///Service.java', languageId: 'java', origin: 'workspace' as const,
    codeOrigin: 'repository' as const, wasOpened: true,
  };
  const service = materializeSymbol(document, {
    name: 'Service', kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
  });
  const extra = materializeSymbol(document, {
    name: 'Extra', kind: 5,
    range: { start: { line: 3, character: 0 }, end: { line: 4, character: 1 } },
    selectionRange: { start: { line: 3, character: 6 }, end: { line: 3, character: 11 } },
  });
  exhaustive.documents.push(document); candidate.documents.push(document);
  exhaustive.symbols.push(service); candidate.symbols.push(service, extra);
  assert.deepEqual(compareRequiredJavaBatchInventories(exhaustive, candidate), {
    equivalent: true, differences: [],
  });
  assert.equal(compareRequiredJavaBatchInventories(candidate, exhaustive).equivalent, false);
});

test('semantic inventory comparison ignores redundant raw position observations', () => {
  const original = emptyObservationBatch();
  const candidate = emptyObservationBatch();
  original.documents.push({
    id: 'document', uri: occurrence.uri, languageId: 'java', origin: 'workspace',
    codeOrigin: 'repository', wasOpened: true,
  });
  candidate.documents.push(...original.documents);
  original.occurrences.push(occurrence, {
    ...occurrence, id: 'position-definition', capability: 'textDocument/definition', role: 'definition',
  });
  candidate.occurrences.push(occurrence);
  original.semanticTokens.push(token);
  candidate.semanticTokens.push(token);
  assert.deepEqual(compareCrawlSemanticInventories(original, candidate), {
    equivalent: true, differences: [],
  });
});
