import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LSP_NODE_SCHEMA_QUERIES,
  LSP_NODE_TABLES,
  LSP_RELATION_SCHEMA,
  LSP_SCHEMA_QUERIES,
  relationEndpointPairs,
} from '../dist/lbug/schema.js';
import {
  LSP_SYMBOL_KIND,
  LSP_SYMBOL_NODE_TABLE,
  LSP_SYMBOL_NODE_TABLES,
  LSP_RELATION_KIND,
  assertSymbolClass,
  assertSelectionWithinRange,
  assertValidRange,
  symbolKindName,
  symbolNodeTable,
} from '../dist/model.js';
import {
  toCallSiteRow,
  toBuildRootRow,
  toDiagnosticRow,
  toDocumentRow,
  toHoverRow,
  toOccurrenceRow,
  toParameterRow,
  toRelationRow,
  toSemanticTokenRow,
  toSignatureHelpRow,
  toSignatureRow,
  toSymbolRow,
  toSymbolRecord,
} from '../dist/lbug/rows.js';

test('defines all 26 standard LSP symbol kinds without forcing GitNexus labels', () => {
  assert.equal(Object.keys(LSP_SYMBOL_KIND).length, 26);
  assert.equal(symbolKindName(5), 'Class');
  assert.equal(symbolKindName(22), 'EnumMember');
  assert.equal(symbolKindName(99), 'Unknown');
});

test('maps every standard SymbolKind to an exact direct symbol class', () => {
  for (const [kindName, kind] of Object.entries(LSP_SYMBOL_KIND)) {
    assert.doesNotThrow(() => assertSymbolClass({ id: `symbol:${kindName}`, kind, kindName }));
  }
  assert.throws(
    () => assertSymbolClass({ id: 'symbol:bad', kind: 8, kindName: 'Property' }),
    /kind 8 is Field, not Property/,
  );
  assert.throws(
    () => assertSymbolClass({ id: 'symbol:unknown', kind: 99, kindName: 'Unknown' }),
    /unknown SymbolKind 99/,
  );
});

test('gives every standard SymbolKind its own physical Ladybug node class', () => {
  assert.equal(LSP_SYMBOL_NODE_TABLES.length, 26);
  assert.equal(new Set(LSP_SYMBOL_NODE_TABLES).size, 26);
  assert.equal(symbolNodeTable('Field'), 'LspFieldSymbol');
  assert.equal(symbolNodeTable('Property'), 'LspPropertySymbol');
  assert.notEqual(LSP_SYMBOL_NODE_TABLE.Field, LSP_SYMBOL_NODE_TABLE.Property);
  assert.ok(!LSP_NODE_TABLES.includes('LspSymbol'));
});

test('creates one schema statement per node table followed by the relation table', () => {
  assert.equal(LSP_NODE_SCHEMA_QUERIES.length, LSP_NODE_TABLES.length);
  assert.equal(LSP_SCHEMA_QUERIES.length, LSP_NODE_TABLES.length + 1);
  assert.equal(LSP_SCHEMA_QUERIES.at(-1), LSP_RELATION_SCHEMA);

  for (const table of LSP_NODE_TABLES) {
    const matches = LSP_NODE_SCHEMA_QUERIES.filter((ddl) =>
      ddl.includes(`CREATE NODE TABLE ${table} (`),
    );
    assert.equal(matches.length, 1, `${table} must be declared exactly once`);
  }
});

test('persists complete LSP and selection ranges for symbols', () => {
  for (const table of LSP_SYMBOL_NODE_TABLES) {
    const symbolDdl = LSP_NODE_SCHEMA_QUERIES.find((ddl) =>
      ddl.includes(`CREATE NODE TABLE ${table} (`),
    );
    assert.ok(symbolDdl);
    for (const column of [
      'startLine',
      'startCharacter',
      'endLine',
      'endCharacter',
      'selectionStartLine',
      'selectionStartCharacter',
      'selectionEndLine',
      'selectionEndCharacter',
    ]) {
      assert.match(symbolDdl, new RegExp(`\\b${column}\\b`));
    }
  }
});

test('declares only known relationship endpoint tables', () => {
  const tables = new Set(LSP_NODE_TABLES);
  const pairs = relationEndpointPairs();
  assert.equal(pairs.size, 846);
  for (const pair of pairs) {
    const [from, to] = pair.split('|');
    assert.ok(tables.has(from), `unknown source table ${from}`);
    assert.ok(tables.has(to), `unknown target table ${to}`);
  }
});

test('validates zero-based ranges and selection containment', () => {
  const range = {
    start: { line: 3, character: 2 },
    end: { line: 7, character: 1 },
  };
  const selection = {
    start: { line: 3, character: 8 },
    end: { line: 3, character: 15 },
  };
  assert.doesNotThrow(() => assertValidRange(range));
  assert.doesNotThrow(() => assertSelectionWithinRange(range, selection));
  assert.throws(
    () => assertValidRange({ start: { line: 1, character: 2 }, end: { line: 0, character: 2 } }),
    /must not precede/,
  );
  assert.throws(
    () =>
      assertSelectionWithinRange(range, {
        start: { line: 2, character: 0 },
        end: { line: 3, character: 4 },
      }),
    /must be contained/,
  );
});

test('flattens protocol data into rows matching the Ladybug columns', () => {
  const buildRoot = toBuildRootRow({
    id: 'build:maven:service', runId: 'run:one', workspaceUri: 'file:///workspace/service',
    relativePath: 'service', buildSystems: ['maven'], javaMajor: 21,
    importStatus: 'ready', excludedRootIds: [],
  });
  assert.equal(buildRoot.javaMajor, 21);
  assert.equal(buildRoot.configurationHash, null);

  const document = toDocumentRow({
    id: 'doc:one',
    uri: 'file:///workspace/One.java',
    filePath: 'One.java',
    languageId: 'java',
    origin: 'workspace',
    wasOpened: true,
  });
  assert.equal(document.contentHash, null);
  assert.equal(document.wasOpened, true);

  const symbol = toSymbolRow({
    id: 'sym:one',
    documentId: document.id,
    uri: document.uri,
    name: 'One',
    kind: 5,
    kindName: 'Class',
    tags: [],
    range: { start: { line: 2, character: 0 }, end: { line: 8, character: 1 } },
    selectionRange: { start: { line: 2, character: 13 }, end: { line: 2, character: 16 } },
    stableKey: 'java:file:///workspace/One.java:2:13:5:One',
    isExternal: false,
  });
  assert.equal(symbol.startLine, 2);
  assert.equal(symbol.selectionStartCharacter, 13);
  assert.equal(symbol.detail, null);

  const symbolRecord = toSymbolRecord({
    id: 'sym:field',
    documentId: document.id,
    uri: document.uri,
    name: 'value',
    kind: 8,
    kindName: 'Field',
    tags: [],
    range: { start: { line: 3, character: 2 }, end: { line: 3, character: 15 } },
    selectionRange: { start: { line: 3, character: 9 }, end: { line: 3, character: 14 } },
    stableKey: 'java:file:///workspace/One.java:3:9:8:value',
    isExternal: false,
  });
  assert.equal(symbolRecord.table, 'LspFieldSymbol');

  const callSite = toCallSiteRow({
    id: 'call:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: document.id,
    callerSymbolId: symbol.id,
    capability: 'callHierarchy/outgoingCalls',
    direction: 'outgoing',
    range: { start: { line: 4, character: 8 }, end: { line: 4, character: 14 } },
    status: 'mapped',
  });
  assert.equal(callSite.startCharacter, 8);
  assert.equal(callSite.calleeName, null);

  const relation = toRelationRow({
    id: 'rel:one',
    sourceKind: 'LspClassSymbol',
    sourceId: symbol.id,
    targetKind: 'LspCallSite',
    targetId: callSite.id,
    kind: 'HAS_CALLSITE',
    runId: 'run:one',
    capability: 'callHierarchy/outgoingCalls',
    status: 'mapped',
    providerAuthority: 1,
    mappingConfidence: 1,
    isDerived: false,
  });
  assert.equal(relation.from, symbol.id);
  assert.equal(relation.to, callSite.id);
  assert.equal(relation.serverId, null);
  assert.throws(
    () =>
      toRelationRow({
        id: 'rel:bad',
        sourceKind: 'LspDiagnostic',
        sourceId: 'diagnostic:one',
        targetKind: 'LspServer',
        targetId: 'server:one',
        kind: 'RESOLVES_TO',
        runId: 'run:one',
        capability: 'invalid',
        status: 'mapped',
        providerAuthority: 1,
        mappingConfidence: 1,
        isDerived: false,
      }),
    /endpoint pair is not declared/,
  );
  assert.throws(
    () =>
      toRelationRow({
        id: 'rel:wrong-kind',
        sourceKind: 'LspClassSymbol',
        sourceId: symbol.id,
        targetKind: 'LspMethodSymbol',
        targetId: 'sym:two',
        kind: 'HAS_CALLSITE',
        runId: 'run:one',
        capability: 'invalid',
        status: 'mapped',
        providerAuthority: 1,
        mappingConfidence: 1,
        isDerived: false,
      }),
    /kind HAS_CALLSITE does not allow endpoint pair LspClassSymbol\|LspMethodSymbol/,
  );
});

test('preserves every call-hierarchy fromRange as a distinct call site', () => {
  const common = {
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:one',
    callerSymbolId: 'sym:caller',
    capability: 'callHierarchy/outgoingCalls',
    direction: 'outgoing',
    status: 'mapped',
  };
  const first = toCallSiteRow({
    ...common,
    id: 'call:10:4',
    range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } },
  });
  const second = toCallSiteRow({
    ...common,
    id: 'call:12:4',
    range: { start: { line: 12, character: 4 }, end: { line: 12, character: 9 } },
  });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.startLine, second.startLine);
});

test('stores definition LocationLink ranges without overloading ACCESSES or USES', () => {
  const occurrence = toOccurrenceRow({
    id: 'occ:def:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:target',
    capability: 'textDocument/definition',
    uri: 'file:///workspace/Target.java',
    range: { start: { line: 5, character: 0 }, end: { line: 9, character: 1 } },
    selectionRange: { start: { line: 5, character: 13 }, end: { line: 5, character: 19 } },
    originUri: 'file:///workspace/Caller.java',
    originRange: { start: { line: 14, character: 8 }, end: { line: 14, character: 14 } },
    role: 'definition',
    status: 'mapped',
  });
  assert.equal(occurrence.selectionStartCharacter, 13);
  assert.equal(occurrence.originStartLine, 14);
  assert.ok(!Object.values(LSP_RELATION_KIND).includes('ACCESSES'));
  assert.ok(!Object.values(LSP_RELATION_KIND).includes('USES'));
});

test('keeps implementation polymorphic and type hierarchy semantically neutral', () => {
  for (const kind of ['IMPLEMENTATION_OF', 'TYPE_HIERARCHY_SUPERTYPE']) {
    assert.doesNotThrow(() =>
      toRelationRow({
        id: `rel:${kind}`,
        sourceKind: 'LspMethodSymbol',
        sourceId: 'sym:child',
        targetKind: 'LspInterfaceSymbol',
        targetId: 'sym:parent',
        kind,
        runId: 'run:one',
        serverId: 'server:one',
        capability:
          kind === 'IMPLEMENTATION_OF'
            ? 'textDocument/implementation'
            : 'typeHierarchy/supertypes',
        status: 'mapped',
        providerAuthority: 1,
        mappingConfidence: 1,
        isDerived: false,
      }),
    );
  }
  assert.ok(!Object.values(LSP_RELATION_KIND).includes('EXTENDS'));
  assert.ok(!Object.values(LSP_RELATION_KIND).includes('IMPLEMENTS'));
  assert.ok(!Object.values(LSP_RELATION_KIND).includes('METHOD_IMPLEMENTS'));
});

test('persists hover, diagnostics, semantic tokens, and signature help structurally', () => {
  const hover = toHoverRow({
    id: 'hover:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:one',
    capability: 'textDocument/hover',
    requestPosition: { line: 3, character: 4 },
    range: { start: { line: 3, character: 1 }, end: { line: 3, character: 8 } },
    contentFormat: 'markdown',
    contents: '```java\nString value\n```',
    status: 'observed',
  });
  assert.equal(hover.requestCharacter, 4);
  assert.equal(hover.contentFormat, 'markdown');

  const diagnostic = toDiagnosticRow({
    id: 'diagnostic:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:one',
    capability: 'textDocument/publishDiagnostics',
    status: 'observed',
    range: { start: { line: 7, character: 2 }, end: { line: 7, character: 10 } },
    severity: 1,
    code: 'E100',
    source: 'jdtls',
    message: 'Unresolved symbol',
    tags: [],
  });
  assert.equal(diagnostic.code, 'E100');
  assert.equal(diagnostic.status, 'observed');

  const token = toSemanticTokenRow({
    id: 'token:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:one',
    capability: 'textDocument/semanticTokens/full',
    line: 5,
    character: 12,
    length: 6,
    tokenType: 'method',
    tokenModifiers: ['declaration', 'static'],
    status: 'observed',
  });
  assert.deepEqual(token.tokenModifiers, ['declaration', 'static']);

  const help = toSignatureHelpRow({
    id: 'signature-help:one',
    runId: 'run:one',
    serverId: 'server:one',
    documentId: 'doc:one',
    capability: 'textDocument/signatureHelp',
    requestPosition: { line: 9, character: 18 },
    activeSignature: 0,
    activeParameter: 1,
    status: 'observed',
  });
  const signature = toSignatureRow({
    id: 'signature:one',
    signatureHelpId: help.id,
    label: 'save(String id, Value value)',
    documentation: 'Save a value.',
    activeParameter: 1,
    ordinal: 0,
  });
  const parameter = toParameterRow({
    id: 'parameter:one',
    signatureId: signature.id,
    label: 'Value value',
    labelStart: 16,
    labelEnd: 27,
    documentation: 'Value to persist.',
    ordinal: 1,
  });
  assert.equal(help.activeParameter, 1);
  assert.equal(signature.documentation, 'Save a value.');
  assert.equal(parameter.labelStart, 16);
});
