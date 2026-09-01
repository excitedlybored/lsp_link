import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { CompleteCrawlAdapter } from '../src/ingest/crawler.js';
import { workspaceDocument } from '../src/ingest/crawler.js';
import { crawlJdtBatchRoot } from '../src/ingest/jdt-batch-crawler.js';
import type { LspAnalysisRun, LspBuildRoot, LspServer } from '../src/model.js';

test('batch JDT facts derive mapped references and calls without per-symbol queries', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-batch-crawl-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'Sample.java');
  fs.writeFileSync(source, 'class Sample {\n  void target() {}\n  void caller() { target(); }\n}\n');
  const uri = pathToFileURL(source).href;
  const dependencyUri = 'jdt://contents/spring-context.jar/org/springframework/context/ApplicationContext.class';
  let commandCount = 0;
  const adapter = {
    ...emptyAdapter(uri),
    getSessionMetadata: () => ({ processShardId: 'test-shard' }),
    async request<T>(_method: string, params: unknown): Promise<T> {
      commandCount += 1;
      const output = String((params as { arguments: unknown[] }).arguments[0]);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const lines = [
        {
          ...fact('declaration', uri, 0, 0, 3, 1,
            { name: 'Sample', declarationKind: 'class', targetPortableKey: 'T:Sample' }),
          startLine: 1, startCharacter: 0, endLine: 0, endCharacter: 0,
          selectionStartLine: 1, selectionStartCharacter: 6, selectionEndLine: 1, selectionEndCharacter: 12,
        },
        fact('declaration', uri, 1, 2, 1, 18, { name: 'target', declarationKind: 'method', targetPortableKey: 'T:Sample#target()T:void' }),
        fact('declaration', uri, 2, 2, 2, 29, { name: 'caller', declarationKind: 'method', targetPortableKey: 'T:Sample#caller()T:void' }),
        fact('occurrence', uri, 2, 18, 2, 24, { targetPortableKey: 'T:Sample#target()T:void' }),
        fact('call', uri, 2, 18, 2, 26, { targetPortableKey: 'T:Sample#target()T:void' }),
        fact('bindingDefinition', dependencyUri, 10, 2, 10, 20, {
          requestUri: uri, name: 'getBean', declarationKind: 'method',
          targetPortableKey: 'T:org.springframework.context.ApplicationContext#getBean(T:java.lang.Class;)T:java.lang.Object',
        }),
        fact('occurrence', uri, 2, 25, 2, 32, {
          targetPortableKey: 'T:org.springframework.context.ApplicationContext#getBean(T:java.lang.Class;)T:java.lang.Object',
        }),
        fact('call', uri, 2, 25, 2, 28, {
          targetPortableKey: 'T:org.springframework.context.ApplicationContext#getBean(T:java.lang.Class;)T:java.lang.Object',
        }),
        { kind: 'summary', schemaVersion: 1 },
      ];
      fs.writeFileSync(output, lines.map((value) => JSON.stringify(value)).join('\n') + '\n');
      const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
      const manifest = `${output}.manifest.json`;
      fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, status: 'complete', output, sha256 }));
      return { schemaVersion: 1, status: 'complete', output, manifest, sha256 } as T;
    },
  };
  const run: LspAnalysisRun = {
    id: 'run', workspaceUri: pathToFileURL(workspace).href, repositoryPath: workspace,
    protocolVersion: '3.18', positionEncoding: 'utf-16', status: 'complete', startedAt: new Date(0).toISOString(),
    requestedLanguages: ['java'], errorCount: 0, timeoutCount: 0,
  };
  const root: LspBuildRoot = {
    id: 'gradle:.', runId: run.id, workspaceUri: run.workspaceUri, repositoryPath: workspace,
    relativePath: '.', buildSystems: ['gradle'], importStatus: 'ready', excludedRootIds: [],
  };
  const server: LspServer = { id: 'server', runId: run.id, name: 'jdtls', languageId: 'java', status: 'partial', capabilitiesJson: '{}' };
  const batch = await crawlJdtBatchRoot({
    run, server, buildRoot: root, documents: [workspaceDocument(source, root.id)], files: [source],
    adapter, repositoryPath: workspace,
  });
  assert.equal(commandCount, 1);
  assert.equal(batch.symbols.length, 4);
  assert.deepEqual(batch.symbols[0]?.range, {
    start: { line: 1, character: 0 }, end: { line: 1, character: 12 },
  });
  assert.equal(batch.occurrences.length, 2);
  assert.ok(batch.occurrences.every((occurrence) => occurrence.status === 'mapped'));
  assert.equal(batch.callSites.length, 2);
  assert.ok(batch.documents.some((document) =>
    document.uri === dependencyUri && document.origin === 'dependency'));
  assert.ok(batch.coverage.some((coverage) =>
    coverage.capability === 'gitnexus.java/batchDefinitions' && coverage.resultCount === 1));
  assert.ok(batch.coverage.every((coverage) => coverage.capability.startsWith('gitnexus.java/batch')));
});

function fact(kind: string, uri: string, startLine: number, startCharacter: number, endLine: number,
  endCharacter: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { kind, uri, startLine, startCharacter, endLine, endCharacter,
    selectionStartLine: startLine, selectionStartCharacter: startCharacter,
    selectionEndLine: startLine, selectionEndCharacter: startCharacter + String(extra.name ?? '').length,
    ...extra };
}

function emptyAdapter(uri: string): CompleteCrawlAdapter {
  return {
    id: 'jdtls', getServerCapabilities: () => ({}), documentUri: () => uri,
    async openDocument() {}, async closeDocument() {}, async documentSymbols() { return []; },
    async prepareCallHierarchy() { return []; }, async getOutgoingCalls() { return []; }, async getIncomingCalls() { return []; },
    async request<T>() { return undefined as T; }, takeNotifications<T>() { return [] as T[]; },
  };
}
