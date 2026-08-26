import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { CompleteCrawlAdapter, RawCallHierarchyItem } from '../src/ingest/crawler.js';
import { crawlLspBuildRoot, workspaceDocument } from '../src/ingest/crawler.js';
import type { CrawlPlannerDecision } from '../src/ingest/crawl-planner.js';
import { compareCrawlSemanticInventories } from '../src/ingest/semantic-inventory.js';
import type { LspAnalysisRun, LspBuildRoot, LspRange, LspServer } from '../src/model.js';

test('facts-first crawl preserves semantic inventory while covering cross-document reference tokens', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-first-crawl-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const callerPath = path.join(workspace, 'Caller.java');
  const servicePath = path.join(workspace, 'Service.java');
  fs.writeFileSync(callerPath, 'class Caller {\n  void call() {\n    save();\n  }\n}\n');
  fs.writeFileSync(servicePath, 'class Service {\n  void save() {}\n}\n');
  const callerUri = pathToFileURL(callerPath).href;
  const serviceUri = pathToFileURL(servicePath).href;
  const callerClass = item('Caller', 5, callerUri, range(0, 0, 4, 1), range(0, 6, 0, 12));
  const callerMethod = item('call', 6, callerUri, range(1, 2, 3, 3), range(1, 7, 1, 11));
  const serviceClass = item('Service', 5, serviceUri, range(0, 0, 2, 1), range(0, 6, 0, 13));
  const serviceMethod = item('save', 6, serviceUri, range(1, 2, 1, 16), range(1, 7, 1, 11));
  const invocationRange = range(2, 4, 2, 8);
  const run: LspAnalysisRun = {
    id: 'run', workspaceUri: pathToFileURL(workspace).href, repositoryPath: workspace,
    protocolVersion: '3.18', positionEncoding: 'utf-16', status: 'complete',
    startedAt: '2026-08-25T00:00:00Z', requestedLanguages: ['java'], errorCount: 0, timeoutCount: 0,
  };
  const root: LspBuildRoot = {
    id: 'bazel:.', runId: run.id, workspaceUri: run.workspaceUri, repositoryPath: workspace,
    relativePath: '.', buildSystems: ['bazel'], importStatus: 'ready', excludedRootIds: [],
  };
  const server: LspServer = {
    id: 'server', runId: run.id, name: 'jdtls', languageId: 'java', status: 'complete',
    capabilitiesJson: '{}', buildRootId: root.id,
  };
  const documents = [workspaceDocument(callerPath, root.id), workspaceDocument(servicePath, root.id)];

  const legacyAdapter = fixtureAdapter();
  const factsAdapter = fixtureAdapter();
  const decisions: CrawlPlannerDecision[] = [];
  const legacy = await crawlLspBuildRoot({
    run, server, buildRoot: root, documents: documents.map((document) => ({ ...document })),
    adapter: legacyAdapter.adapter, repositoryPath: workspace, plannerMode: 'legacy',
  });
  const candidate = await crawlLspBuildRoot({
    run, server, buildRoot: root, documents: documents.map((document) => ({ ...document })),
    adapter: factsAdapter.adapter, repositoryPath: workspace, plannerMode: 'facts-first',
    onPlannerDecision: (decision) => decisions.push(decision),
  });

  assert.equal(legacyAdapter.tokenDefinitionRequests(), 2);
  assert.equal(factsAdapter.tokenDefinitionRequests(), 0);
  assert.ok(decisions.some((decision) =>
    decision.documentUri === callerUri && decision.line === 2 && decision.character === 4
    && decision.action === 'covered' && decision.coveringEvidenceIds.length === 1));
  assert.deepEqual(compareCrawlSemanticInventories(legacy, candidate), {
    equivalent: true, differences: [],
  });

  function fixtureAdapter(): { adapter: CompleteCrawlAdapter; tokenDefinitionRequests: () => number } {
    let tokenDefinitions = 0;
    const adapter: CompleteCrawlAdapter = {
      id: 'jdtls',
      getServerCapabilities: () => ({
        documentSymbolProvider: true, definitionProvider: true, declarationProvider: true,
        referencesProvider: true, hoverProvider: true,
        semanticTokensProvider: { full: true, legend: { tokenTypes: ['method'], tokenModifiers: [] } },
      }),
      documentUri: (filePath) => pathToFileURL(filePath).href,
      async openDocument() {},
      async closeDocument() {},
      async documentSymbols(filePath) {
        return filePath === callerPath
          ? [{ ...callerClass, children: [callerMethod] }]
          : [{ ...serviceClass, children: [serviceMethod] }];
      },
      async prepareCallHierarchy() { return []; },
      async getOutgoingCalls() { return []; },
      async getIncomingCalls() { return []; },
      async request<T>(method: string, params: unknown): Promise<T> {
        const request = params as { textDocument?: { uri?: string }; position?: { line: number; character: number } };
        const uri = request.textDocument?.uri;
        const position = request.position;
        if (method === 'textDocument/semanticTokens/full') {
          return (uri === callerUri ? { data: [2, 4, 4, 0, 0] } : { data: [] }) as T;
        }
        if (method === 'textDocument/references') {
          return (uri === serviceUri && position?.line === 1
            ? [{ uri: callerUri, range: invocationRange }]
            : []) as T;
        }
        if (method === 'textDocument/definition' || method === 'textDocument/declaration') {
          if (uri === callerUri && position?.line === 2 && position.character === 4) tokenDefinitions += 1;
          const target = uri === callerUri && position?.line === 2 ? serviceMethod : undefined;
          return (target ? [{ uri: target.uri, range: target.selectionRange }] : []) as T;
        }
        if (method === 'textDocument/hover') return ({ contents: 'resolved' } as T);
        return ([] as T);
      },
      takeNotifications: () => [],
    };
    return { adapter, tokenDefinitionRequests: () => tokenDefinitions };
  }
});

function item(
  name: string, kind: number, uri: string, itemRange: LspRange, selectionRange: LspRange,
): RawCallHierarchyItem {
  return { name, kind, uri, range: itemRange, selectionRange };
}

function range(
  startLine: number, startCharacter: number, endLine: number, endCharacter: number,
): LspRange {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
