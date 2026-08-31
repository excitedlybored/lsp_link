import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  crawlRegisteredRepositoryLanguages,
  discoverRegisteredSemanticSources,
} from '../src/application/polyglot-crawl-stage.js';
import type { LspAnalysisRun } from '../src/model.js';
import { emptyRepositoryInventoryBatch, repositoryStableId } from '../src/repository/model.js';
import { LspAdapterRegistry, type ILspAdapter } from '../../lsp_server/public-api.js';

test('routes inventory source documents through a registered semantic adapter exactly once', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-crawl-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'ExampleWorkflow.kt');
  fs.writeFileSync(source, 'class ExampleWorkflow');
  const inventory = emptyRepositoryInventoryBatch();
  inventory.documents.push({
    id: repositoryStableId('document', source), runId: 'inventory', path: source,
    relativePath: 'ExampleWorkflow.kt', languageId: 'kotlin', kind: 'source', contentHash: 'hash',
    byteSize: 20, lineCount: 1, codeOrigin: 'repository', providerId: 'kotlin-lexical',
    providerVersion: '1', authority: 'structural_lexical',
  });
  let starts = 0;
  let symbolRequests = 0;
  const registry = new LspAdapterRegistry([() => kotlinAdapter(
      () => { starts += 1; },
      () => { symbolRequests += 1; },
    )]);
  const run: LspAnalysisRun = {
    id: 'run', workspaceUri: pathToFileURL(workspace).href, repositoryPath: workspace,
    protocolVersion: '3.18', positionEncoding: 'utf-16', status: 'complete',
    startedAt: new Date().toISOString(), requestedLanguages: ['java'], errorCount: 0, timeoutCount: 0,
  };
  const batch = await crawlRegisteredRepositoryLanguages({
    workspacePath: workspace, run, repositoryInventory: inventory, adapterRegistry: registry,
    profile: 'core',
  });
  assert.equal(starts, 1);
  assert.equal(symbolRequests, 1);
  assert.equal(batch.symbols.length, 1);
  assert.equal(batch.documents[0]?.languageId, 'kotlin');
  assert.deepEqual(run.requestedLanguages, ['java', 'kotlin']);
});

test('discovers semantic sources from adapter metadata without scanning dependency trees', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-discovery-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/service.py'), 'def service(): pass');
  fs.writeFileSync(path.join(workspace, 'src/client.ts'), 'export const client = 1');
  fs.writeFileSync(path.join(workspace, 'node_modules/pkg/ignored.ts'), 'export {}');
  const relative = discoverRegisteredSemanticSources(workspace, new LspAdapterRegistry())
    .map((value) => path.relative(workspace, value)).sort();
  assert.deepEqual(relative, ['src/client.ts', 'src/service.py']);
});

function kotlinAdapter(onStart: () => void, onSymbols: () => void): ILspAdapter {
  return {
    id: 'kotlin-lsp', language: 'kotlin', fileExtensions: ['.kt', '.kts'], maxConcurrentRequests: 1,
    getSessionMetadata: () => ({}), isAvailable: async () => true,
    async start() { onStart(); }, getServerCapabilities: () => ({ documentSymbolProvider: true }),
    request: async () => undefined as never, documentUri: (file) => pathToFileURL(file).href,
    takeNotifications: () => [], openDocument: async () => {}, closeDocument: async () => {},
    prepareCallHierarchy: async () => [], getOutgoingCalls: async () => [], getIncomingCalls: async () => [],
    findImplementations: async () => [], getHover: async () => null,
    async documentSymbols() {
      onSymbols();
      return [{
        name: 'ExampleWorkflow', kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 20 } },
      }];
    },
    findDefinition: async () => [], findReferences: async () => [], shutdown: async () => {},
  };
}
