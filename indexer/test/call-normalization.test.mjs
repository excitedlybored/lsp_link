import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALL_NORMALIZATION_ALGORITHM_VERSION,
  normalizeLogicalCalls,
} from '../dist/derived/call-normalization/normalize.js';
import { DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES } from '../dist/derived/call-normalization/schema.js';

test('normalizes overlapping incoming and outgoing observations through implementation families', () => {
  const batch = fixtureBatch();
  const normalized = normalizeLogicalCalls(batch);

  assert.equal(normalized.runs[0].algorithmVersion, CALL_NORMALIZATION_ALGORITHM_VERSION);
  assert.equal(normalized.runs[0].observationCount, 4);
  assert.equal(normalized.runs[0].invocationCount, 2);
  const first = normalized.invocations.find((value) => value.observationCount === 3);
  assert.ok(first);
  assert.equal(first.canonicalTargetId, 'method:contract');
  assert.deepEqual(first.directions, ['incoming', 'outgoing']);
  assert.deepEqual(
    [first.startLine, first.startCharacter, first.endLine, first.endCharacter],
    [10, 4, 10, 30],
  );
  assert.equal(first.confidence, 1);
  assert.equal(normalized.relations.filter((value) =>
    value.kind === 'NORMALIZES_TO' && value.targetId === first.id).length, 3);
});

test('does not merge adjacent or unresolved calls', () => {
  const batch = fixtureBatch();
  batch.callSites = [
    callSite('adjacent:a', 'outgoing', 20, 0, 20, 5),
    callSite('adjacent:b', 'incoming', 20, 5, 20, 10),
    callSite('unresolved', 'outgoing', 30, 0, 30, 4, 'missing'),
  ];
  batch.relations = [];
  const normalized = normalizeLogicalCalls(batch);

  assert.equal(normalized.invocations.length, 3);
  assert.ok(normalized.invocations.every((value) => value.status === 'unresolved'));
  assert.equal(normalized.invocations.filter((value) => value.targetFamilyId === 'unresolved:missing').length, 1);
});

test('declares a separate derived schema without extending LspRelation', () => {
  assert.ok(DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES.some((ddl) =>
    ddl.includes('CREATE NODE TABLE DerivedCallNormalizationRun')));
  assert.ok(DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES.some((ddl) =>
    ddl.includes('CREATE NODE TABLE LspLogicalInvocation')));
  assert.ok(DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES.some((ddl) =>
    ddl.includes('CREATE REL TABLE DerivedCallRelation')));
  assert.ok(DERIVED_CALL_NORMALIZATION_SCHEMA_QUERIES.every((ddl) => !ddl.includes('LspRelation')));
});

function fixtureBatch() {
  const caller = symbol('method:caller', 'caller-stable');
  const contract = symbol('method:contract', 'contract-stable');
  const implementation = symbol('method:implementation', 'implementation-stable');
  const callSites = [
    callSite('site:outgoing', 'outgoing', 10, 4, 10, 30),
    callSite('site:incoming-contract', 'incoming', 10, 15, 10, 30),
    callSite('site:incoming-implementation', 'incoming', 10, 15, 10, 30),
    callSite('site:second-expression', 'outgoing', 12, 4, 12, 30),
  ];
  return {
    analysisRuns: [{ id: 'run:test' }],
    documents: [{ id: 'document:test', uri: 'file:///workspace/Test.java' }],
    symbols: [caller, contract, implementation],
    callSites,
    relations: [
      relation('implementation', implementation.id, contract.id, 'IMPLEMENTATION_OF'),
      relation('target:outgoing', callSites[0].id, contract.id, 'RESOLVES_TO'),
      relation('target:incoming-contract', callSites[1].id, contract.id, 'RESOLVES_TO'),
      relation('target:incoming-implementation', callSites[2].id, implementation.id, 'RESOLVES_TO'),
      relation('target:second-expression', callSites[3].id, contract.id, 'RESOLVES_TO'),
    ],
  };
}

function symbol(id, stableKey) {
  return { id, stableKey, kindName: 'Method', kind: 6 };
}

function callSite(id, direction, startLine, startCharacter, endLine, endCharacter, calleeName = 'validate') {
  return {
    id, runId: 'run:test', serverId: 'server:test', documentId: 'document:test',
    callerSymbolId: 'method:caller',
    capability: direction === 'incoming'
      ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls',
    direction, range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    calleeName, status: 'mapped',
  };
}

function relation(id, sourceId, targetId, kind) {
  return { id, sourceId, targetId, kind };
}
