import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BaseStdioLspAdapter } from '../adapters/base-stdio-adapter.js';
import {
  cleanupJdtlsShardWorkspace,
  planJdtlsBuildRootShardsWithinBudget,
  prepareJdtlsShardWorkspace,
  type JdtlsBuildRootShard,
} from '../adapters/java/jdtls-sharding.js';
import type { JavaBuildRoot } from '../adapters/java/jdtls-runtime.js';
import { findBundledKotlinLsp } from '../adapters/kotlin/kotlin-lsp-adapter.js';
import type { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';

class TestStdioAdapter extends BaseStdioLspAdapter {
  readonly id = 'test-lsp';
  readonly language = 'test';
  readonly fileExtensions = ['.test'] as const;
  readonly maxConcurrentRequests = 2;

  async isAvailable(): Promise<boolean> { return true; }
  protected async buildProcessLaunch() { return { command: 'unused', args: [] }; }
  attach(connection: { sendRequest: (...args: unknown[]) => Promise<unknown>; sendNotification?: (...args: unknown[]) => Promise<void> }): void {
    this.connection = connection as never;
  }
}

test('default registry routes Kotlin source and script files to the Kotlin adapter', () => {
  const registry = new LspAdapterRegistry();
  assert.equal(registry.getLanguageForFile('/workspace/src/ExampleWorkflow.kt'), 'kotlin');
  assert.equal(registry.getLanguageForFile('/workspace/build.gradle.kts'), 'kotlin');
  assert.ok(registry.getSupportedFileExtensions().includes('.kt'));
  assert.ok(registry.getSupportedFileExtensions().includes('.kts'));
});

test('finds the version-pinned Kotlin launcher from a nested repository path', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');
  const nestedPath = path.join(repositoryRoot, 'lsp_server', 'test');
  const launcher = findBundledKotlinLsp(nestedPath);
  assert.equal(
    launcher,
    path.join(
      repositoryRoot, '.gitnexus', 'tools', 'kotlin-lsp', '262.9593.0',
      'bin', 'intellij-server',
    ),
  );
  assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
});

test('keeps every vendored Kotlin archive chunk below the Git host file limit', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');
  const archiveDirectory = path.join(repositoryRoot, 'vendor', 'kotlin-lsp', 'archive');
  const prefix = 'kotlin-lsp-262.9593.0-linux-x64.tar.zst.part-';
  const parts = fs.readdirSync(archiveDirectory).filter((name) => name.startsWith(prefix)).sort();
  assert.ok(parts.length > 1);
  const checksums = fs.readFileSync(path.join(archiveDirectory, 'SHA256SUMS'), 'utf8');
  for (const part of parts) {
    assert.ok(fs.statSync(path.join(archiveDirectory, part)).size < 100_000_000, part);
    assert.match(checksums, new RegExp(`  ${part.replaceAll('.', '\\.')}(?:\\n|$)`));
  }
});

test('enforces adapter request concurrency at the JSON-RPC boundary', async () => {
  const adapter = new TestStdioAdapter();
  let active = 0;
  let maximum = 0;
  adapter.attach({
    async sendRequest() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return true;
    },
  });
  await Promise.all(Array.from({ length: 12 }, () => adapter.request('test/request', {})));
  assert.equal(maximum, 2);
});

test('coalesces and memoizes identical read-only LSP requests within one session', async () => {
  const adapter = new TestStdioAdapter();
  let requests = 0;
  adapter.attach({
    async sendRequest() {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ uri: 'file:///Target.kt' }];
    },
  });
  const firstParams = {
    textDocument: { uri: 'file:///Source.kt' }, position: { line: 4, character: 9 },
  };
  const sameParamsDifferentKeyOrder = {
    position: { character: 9, line: 4 }, textDocument: { uri: 'file:///Source.kt' },
  };
  const [first, second] = await Promise.all([
    adapter.request('textDocument/definition', firstParams),
    adapter.request('textDocument/definition', sameParamsDifferentKeyOrder),
  ]);
  assert.deepEqual(first, second);
  assert.equal(requests, 1);
  assert.deepEqual(adapter.getRequestCacheStats(), { hits: 1, misses: 1, entries: 1 });
  await adapter.shutdown();
  assert.deepEqual(adapter.getRequestCacheStats(), { hits: 0, misses: 0, entries: 0 });
});

test('does not cache a failed semantic request', async () => {
  const adapter = new TestStdioAdapter();
  let requests = 0;
  adapter.attach({
    async sendRequest() {
      requests += 1;
      if (requests === 1) throw new Error('transient failure');
      return [];
    },
  });
  const params = { textDocument: { uri: 'file:///Retry.kt' }, position: { line: 0, character: 0 } };
  await assert.rejects(adapter.request('textDocument/definition', params), /transient failure/);
  await adapter.request('textDocument/definition', params);
  assert.equal(requests, 2);
});

test('propagates protocol errors instead of reporting successful empty observations', async () => {
  const adapter = new TestStdioAdapter();
  adapter.attach({ async sendRequest() { throw new Error('server rejected request'); } });
  await assert.rejects(adapter.documentSymbols('/missing.test'), /JSON-RPC connection|ENOENT/);
  await assert.rejects(adapter.request('test/request', {}), /server rejected request/);
});

test('does not mark a document opened when didOpen fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-open-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, 'sample.test');
  fs.writeFileSync(document, 'content');
  const adapter = new TestStdioAdapter();
  let attempts = 0;
  adapter.attach({
    async sendRequest() { return null; },
    async sendNotification() {
      attempts += 1;
      throw new Error('dead pipe');
    },
  });
  await assert.rejects(adapter.openDocument(document), /dead pipe/);
  await assert.rejects(adapter.openDocument(document), /dead pipe/);
  assert.equal(attempts, 2);
});

test('coalesces concurrent starts and creates one adapter per workspace', async () => {
  const registry = new LspAdapterRegistry();
  let starts = 0;
  let creations = 0;
  const factory = (): ILspAdapter => {
    creations += 1;
    return fakeAdapter(async () => {
      starts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  registry.registerAdapterFactory(factory);
  const first = await Promise.all([
    registry.getOrStartAdapter('factory-test', '/workspace/one'),
    registry.getOrStartAdapter('factory-test', '/workspace/one'),
  ]);
  assert.strictEqual(first[0], first[1]);
  const second = await registry.getOrStartAdapter('factory-test', '/workspace/two');
  assert.notStrictEqual(first[0], second);
  assert.equal(starts, 2);
  assert.equal(creations, 3, 'one routing prototype plus one instance per workspace');
  await registry.shutdownAll();
});

test('uses run-scoped JDT workspaces and removes only the owned shard', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-session-test-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const shard: JdtlsBuildRootShard = { id: 'jdtls-shard-1', roots: [], sourceFileCount: 0 };
  const first = prepareJdtlsShardWorkspace(repository, shard);
  const second = prepareJdtlsShardWorkspace(repository, shard);
  assert.notEqual(first.workspacePath, second.workspacePath);
  cleanupJdtlsShardWorkspace(first);
  assert.equal(fs.existsSync(first.workspacePath), false);
  assert.equal(fs.existsSync(second.workspacePath), true);
  cleanupJdtlsShardWorkspace(second);
});

test('reduces JDT process count to remain inside the total heap budget', () => {
  const roots: JavaBuildRoot[] = Array.from({ length: 4 }, (_, index) => ({
    id: `root-${index}`, workspacePath: `/repo/root-${index}`, relativePath: `root-${index}`,
    systems: ['bazel'], excludedRoots: [],
  }));
  const counts = new Map(roots.map((root) => [root.id, 1_000]));
  const plan = planJdtlsBuildRootShardsWithinBudget(roots, 4, counts, 4);
  assert.equal(plan.length, 2);
  assert.equal(plan.reduce((sum, shard) => sum + shard.sourceFileCount, 0), 4_000);
});

function fakeAdapter(start: () => Promise<void>): ILspAdapter {
  return {
    id: 'factory-test', language: 'factory-test', fileExtensions: ['.factory'], maxConcurrentRequests: 1,
    getSessionMetadata: () => ({}), isAvailable: async () => true, start,
    getServerCapabilities: () => ({}), request: async () => undefined as never,
    documentUri: (value) => value, takeNotifications: () => [], openDocument: async () => {},
    closeDocument: async () => {}, prepareCallHierarchy: async () => [], getOutgoingCalls: async () => [],
    getIncomingCalls: async () => [], findImplementations: async () => [], getHover: async () => null,
    documentSymbols: async () => [], findDefinition: async () => [], findReferences: async () => [],
    shutdown: async () => {},
  };
}
