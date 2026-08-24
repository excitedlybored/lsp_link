import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ingestCalls,
  ingestDocumentSymbols,
  ingestOccurrence,
  ingestRun,
} from '../dist/ingest/builders.js';
import { mergeObservationBatches } from '../dist/ingest/batch.js';
import {
  LSP_KG_CAPABILITIES,
  collectCapabilities,
  withCompleteCapabilityCoverage,
} from '../dist/ingest/collector.js';
import { LspLadybugRepository } from '../dist/lbug/repository.js';

const run = {
  id: 'run:one', workspaceUri: 'file:///workspace', protocolVersion: '3.18',
  positionEncoding: 'utf-16', status: 'complete', startedAt: '2026-08-24T00:00:00Z',
  requestedLanguages: ['java'], errorCount: 0, timeoutCount: 0,
};
const server = {
  id: 'server:jdtls', runId: run.id, name: 'jdtls', version: '1',
  languageId: 'java', status: 'complete', capabilitiesJson: '{}',
};
const document = {
  id: 'doc:service', uri: 'file:///workspace/Service.java', filePath: 'Service.java',
  languageId: 'java', origin: 'workspace', wasOpened: true,
};
const context = {
  runId: run.id, server, document, capability: 'textDocument/documentSymbol',
};

test('normalizes hierarchy, call sites, occurrences, and run provenance into one batch', () => {
  const symbols = ingestDocumentSymbols(context, [{
    name: 'Service', kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
    children: [{
      name: 'save', detail: 'save(String)', kind: 6,
      range: { start: { line: 2, character: 2 }, end: { line: 5, character: 3 } },
      selectionRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 11 } },
    }],
  }]);
  const [type, method] = symbols.symbols;
  assert.equal(type.kindName, 'Class');
  assert.equal(method.kindName, 'Method');
  assert.deepEqual(symbols.relations.map((relation) => relation.kind), ['DEFINES', 'CONTAINS']);

  const calls = ingestCalls(
    { ...context, capability: 'callHierarchy/outgoingCalls' },
    'outgoing',
    [{
      caller: method, target: method,
      fromRanges: [
        { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } },
        { start: { line: 4, character: 4 }, end: { line: 4, character: 8 } },
      ],
    }],
  );
  assert.equal(calls.callSites.length, 2);
  assert.equal(calls.relations.filter((relation) => relation.kind === 'RESOLVES_TO').length, 2);

  const occurrence = ingestOccurrence(
    { ...context, capability: 'textDocument/implementation' },
    {
      id: 'occ:impl', uri: document.uri,
      range: method.range, selectionRange: method.selectionRange,
      role: 'implementation', status: 'mapped',
    },
    method,
  );
  assert.ok(occurrence.relations.some((relation) => relation.kind === 'IMPLEMENTATION_LOCATION_OF'));

  const batch = mergeObservationBatches(
    ingestRun(run, [server], [document]), symbols, calls, occurrence,
  );
  assert.equal(batch.analysisRuns.length, 1);
  assert.equal(batch.symbols.length, 2);
  assert.equal(batch.relations.length, 10);
});

test('persists build-root ownership and server import provenance', () => {
  const buildRoot = {
    id: 'build:maven:service', runId: run.id, workspaceUri: 'file:///workspace/service',
    repositoryPath: '/workspace', relativePath: 'service', buildSystems: ['maven'],
    javaMajor: 21, importStatus: 'ready', excludedRootIds: [],
  };
  const rootedServer = { ...server, buildRootId: buildRoot.id };
  const rootedDocument = { ...document, buildRootId: buildRoot.id };
  const batch = ingestRun(run, [rootedServer], [rootedDocument], [buildRoot]);
  assert.equal(batch.buildRoots.length, 1);
  assert.ok(batch.relations.some((relation) => relation.kind === 'HAS_BUILD_ROOT'));
  assert.ok(batch.relations.some((relation) => relation.kind === 'IMPORTS_BUILD_ROOT'));
  assert.ok(batch.relations.some((relation) => relation.kind === 'OWNS_DOCUMENT'));
});

test('writes concrete nodes before endpoint-typed relations in one transaction', async () => {
  const connection = new RecordingConnection();
  const repository = new LspLadybugRepository(connection);
  const symbols = ingestDocumentSymbols(context, [{
    name: 'count', kind: 8,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
    selectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
  }]);
  await repository.writeBatch(mergeObservationBatches(
    ingestRun(run, [server], [document]), symbols,
  ));

  assert.equal(connection.queries[0], 'BEGIN TRANSACTION');
  assert.equal(connection.queries.at(-1), 'COMMIT');
  assert.ok(connection.prepared.some((query) => query.startsWith('CREATE (n:LspFieldSymbol')));
  assert.ok(connection.prepared.some((query) =>
    query.includes('MATCH (source:LspDocument') && query.includes('target:LspFieldSymbol'),
  ));
  assert.ok(!connection.prepared.some((query) => query.includes(':LspSymbol')));
});

test('records unsupported, empty, failed, timeout, and observed capability coverage distinctly', async () => {
  const context = { runId: run.id, serverId: server.id };
  const tasks = [
    task('unsupported/capability', false, 1, async () => { throw new Error('must not run'); }),
    task('empty/capability', true, 1, async () => mergeObservationBatches()),
    task('failed/capability', true, 1, async () => { throw new Error('server error'); }),
    task('timeout/capability', true, 1, async () => { throw new Error('request timed out'); }),
    task('observed/capability', true, 1, async () => ingestDocumentSymbols(
      { runId: run.id, server, document, capability: 'observed/capability' },
      [{
        name: 'ready', kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        selectionRange: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
      }],
    )),
  ];
  const batch = await collectCapabilities(context, tasks);
  assert.deepEqual(batch.coverage.map((item) => item.status), [
    'unsupported', 'empty', 'failed', 'timeout', 'observed',
  ]);
  assert.equal(batch.symbols.length, 1);
  assert.equal(batch.coverage[2].failureCount, 1);
  assert.equal(batch.coverage[3].timeoutCount, 1);
  assert.equal(batch.relations.filter((relation) => relation.kind === 'REPORTS_COVERAGE').length, 5);
});

test('requires an explicit coverage outcome for the complete semantic capability inventory', async () => {
  const scheduled = [task(
    'textDocument/documentSymbol', true, 0, async () => mergeObservationBatches(),
  )];
  const complete = withCompleteCapabilityCoverage(scheduled, 'java', document.id);
  const batch = await collectCapabilities(
    { runId: run.id, serverId: server.id }, complete,
  );
  assert.equal(batch.coverage.length, LSP_KG_CAPABILITIES.length);
  assert.equal(new Set(batch.coverage.map((item) => item.capability)).size, LSP_KG_CAPABILITIES.length);
  assert.equal(
    batch.coverage.find((item) => item.capability === 'textDocument/documentSymbol').status,
    'excluded',
  );
  assert.equal(
    batch.coverage.find((item) => item.capability === 'workspace/diagnostic').status,
    'unsupported',
  );
});

function task(capability, supported, eligibleCount, execute) {
  return { capability, supported, eligibleCount, execute, languageId: 'java', documentId: document.id };
}

class RecordingConnection {
  queries = [];
  prepared = [];
  executions = [];

  async query(cypher) {
    this.queries.push(cypher);
    return { close() {} };
  }

  async prepare(cypher) {
    this.prepared.push(cypher);
    return { isSuccess: () => true };
  }

  async execute(statement, parameters) {
    this.executions.push({ statement, parameters });
    return { close() {} };
  }
}
