import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { BaseStdioLspAdapter } from '../adapters/base-stdio-adapter.js';
import {
  cleanupJdtlsShardWorkspace,
  planJdtlsBuildRootShardsWithinBudget,
  prepareJdtlsShardWorkspace,
  pruneStaleJdtlsWorkspaces,
  type JdtlsBuildRootShard,
} from '../adapters/java/jdtls-sharding.js';

test('prunes abandoned JDT workspaces without touching a live process', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-stale-workspaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = path.join(root, '99999999-abandoned');
  const active = path.join(root, `${process.pid}-active`);
  fs.mkdirSync(path.join(stale, 'shard', '.jdtls-data'), { recursive: true });
  fs.mkdirSync(path.join(active, 'shard', '.jdtls-data'), { recursive: true });

  pruneStaleJdtlsWorkspaces(root);

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(active), true);
});
import {
  JdtlsStartupTelemetry,
  jdtlsStartupHeartbeatMs,
  jdtlsStartupTimeoutMs,
} from '../adapters/java/jdtls-startup-telemetry.js';
import type { JavaBuildRoot } from '../adapters/java/jdtls-runtime.js';
import { findBundledKotlinLsp } from '../adapters/kotlin/kotlin-lsp-adapter.js';
import { JavaJdtlsAdapter } from '../adapters/java/jdtls-adapter.js';
import { SpringBootLanguageServerAdapter } from '../adapters/java/spring-boot-adapter.js';
import type { ILspAdapter } from '../contracts/lsp-adapter.interface.js';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';
import { validateImportedJavaProjectClasspaths } from '../adapters/java/jdtls-classpath-validation.js';

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

class DiagnosticStdioAdapter extends TestStdioAdapter {
  feedStderr(value: string): void {
    this.recordProcessStderr(value);
  }
  startupError(message: string): Error {
    return this.enrichStartupError(new Error(message));
  }
}

class HardTimeoutStdioAdapter extends TestStdioAdapter {
  protected override queryTimeoutMs(): number { return 10; }
}

class ClientCommandJdtAdapter extends JavaJdtlsAdapter {
  dispatchClientCommand(params: unknown): unknown {
    return this.onServerRequest('workspace/executeClientCommand', params);
  }
}

test('forwards JDT Spring classpath callbacks to the Spring Tools server', async () => {
  const java = new ClientCommandJdtAdapter();
  const spring = new SpringBootLanguageServerAdapter(java, 'maven:app');
  const forwarded: Array<{ method: string; params: unknown }> = [];
  spring.request = async (method: string, params: unknown) => {
    forwarded.push({ method, params });
    return null as never;
  };
  await java.dispatchClientCommand({
    command: 'sts4.classpath.callback',
    arguments: ['file:///workspace/app', { entries: ['/dependency.jar'] }],
  });
  assert.deepEqual(forwarded, [{
    method: 'workspace/executeCommand',
    params: {
      command: 'sts4.classpath.callback',
      arguments: ['file:///workspace/app', { entries: ['/dependency.jar'] }],
    },
  }]);
  await spring.shutdown();
});

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
  const launcher = findBundledKotlinLsp(nestedPath, 'linux', 'x64');
  assert.equal(
    launcher,
    path.join(
      repositoryRoot, '.gitnexus', 'tools', 'kotlin-lsp', '262.9593.0',
      'bin', 'intellij-server',
    ),
  );
  assert.equal(fs.statSync(launcher).mode & 0o111, 0o111);
  assert.equal(findBundledKotlinLsp(nestedPath, 'darwin', 'arm64'), launcher);
  assert.equal(findBundledKotlinLsp(nestedPath, 'darwin', 'x64'), null);
});

test('keeps every vendored Kotlin archive chunk below the Git host file limit', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');
  const archiveDirectory = path.join(repositoryRoot, 'vendor', 'kotlin-lsp', 'archive');
  const parts = fs.readdirSync(archiveDirectory).filter((name) => name.includes('.part-')).sort();
  assert.ok(parts.some((name) => name.includes('linux-x64')));
  assert.ok(parts.some((name) => name.includes('macos-arm64')));
  const checksums = fs.readFileSync(path.join(archiveDirectory, 'SHA256SUMS'), 'utf8');
  for (const part of parts) {
    assert.ok(fs.statSync(path.join(archiveDirectory, part)).size < 100_000_000, part);
    assert.match(checksums, new RegExp(`  ${part.replaceAll('.', '\\.')}(?:\\n|$)`));
  }
});

test('keeps the vendored Spring Tools runtime below the Git host file limit', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../..');
  const archive = path.join(
    repositoryRoot, 'vendor', 'spring-tools', 'vscode-spring-boot-5.3.0.RELEASE.vsix',
  );
  assert.equal(fs.statSync(archive).size, 83_000_863);
  assert.ok(fs.statSync(archive).size < 100_000_000);
  assert.match(
    fs.readFileSync(path.join(repositoryRoot, 'vendor', 'spring-tools', 'README.md'), 'utf8'),
    /8e555da123e5b4edb7449d3ef1f922a922503e64a86cd66cbe713638f94a9e50/,
  );
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

test('rejects locally when a language server ignores request cancellation', async () => {
  const adapter = new HardTimeoutStdioAdapter();
  adapter.attach({
    async sendRequest() { return await new Promise<never>(() => {}); },
  });
  const startedAt = Date.now();
  await assert.rejects(
    adapter.request('workspace/executeCommand', { command: 'blocked' }),
    /timed out after 10ms.*local request deadline exceeded/,
  );
  assert.ok(Date.now() - startedAt < 1_000);
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

test('rejects an unsupported JDT source layout before preparing a workspace', () => {
  const previous = process.env.GITNEXUS_JDT_SOURCE_LAYOUT;
  process.env.GITNEXUS_JDT_SOURCE_LAYOUT = 'unknown';
  try {
    assert.throws(
      () => prepareJdtlsShardWorkspace('/workspace', { id: 'jdtls-shard-1', roots: [], sourceFileCount: 0 }),
      /must be linked or copied/,
    );
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_JDT_SOURCE_LAYOUT;
    else process.env.GITNEXUS_JDT_SOURCE_LAYOUT = previous;
  }
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

test('scales one JDT startup deadline across source files and classpath entries', () => {
  assert.equal(jdtlsStartupTimeoutMs(100, 20, {}), 180_000);
  assert.equal(jdtlsStartupTimeoutMs(8_741, 1_686, {}), 749_950);
  assert.equal(jdtlsStartupTimeoutMs(100_000, 20_000, {}), 900_000);
  assert.equal(jdtlsStartupTimeoutMs(1, 1, { GITNEXUS_JDT_STARTUP_TIMEOUT_MS: '420000' }), 420_000);
  assert.equal(jdtlsStartupTimeoutMs(1, 1, { GITNEXUS_JDT_CLASSPATH_READY_TIMEOUT_MS: '360000' }), 360_000);
  assert.throws(
    () => jdtlsStartupTimeoutMs(1, 1, { GITNEXUS_JDT_STARTUP_TIMEOUT_MS: 'never' }),
    /must be a positive number/,
  );
  assert.equal(jdtlsStartupHeartbeatMs({}), 15_000);
  assert.equal(jdtlsStartupHeartbeatMs({ GITNEXUS_JDT_STARTUP_HEARTBEAT_MS: '25000' }), 25_000);
});

test('reports deterministic JDT phase, memory, process, and pending-root telemetry', () => {
  let now = 1_000;
  const lines: string[] = [];
  const telemetry = new JdtlsStartupTelemetry({
    shardId: 'jdtls-shard-1', sourceFileCount: 8_741, classpathEntryCount: 1_686,
    heapXmx: '6G', timeoutMs: 600_000, heartbeatMs: 60_000,
    now: () => now, log: (line) => lines.push(line), processRssMiB: () => 512.25,
    processMetadata: () => ({ processId: 4321 }),
  });
  telemetry.start();
  telemetry.setPendingRoots(1);
  telemetry.setPhase('jdt-index-readiness');
  telemetry.noteServerProgress({ token: 'index-1', task: 'Indexing', message: 'Resolving types', percentage: 42, complete: false });
  telemetry.setClasspathReadiness({
    attempts: 7, totalRoots: 1, completedRoots: 0, currentRootId: 'bazel:.',
    expectedEntries: 1_686, classpathEntries: 1_600, modulepathEntries: 20,
    actualEntries: 1_620, matchedEntries: 1_610, missingEntries: 76,
    lastProgressAt: now,
  });
  now += 15_000;
  telemetry.reportHeartbeat();
  telemetry.finish('complete');

  const events = lines.map((line) => JSON.parse(line.replace(/^\[jdtls-startup\] /, '')));
  assert.deepEqual(events.map((event) => event.event), ['start', 'phase', 'heartbeat', 'complete']);
  assert.deepEqual(events[2], {
    event: 'heartbeat', shardId: 'jdtls-shard-1', phase: 'jdt-index-readiness',
    elapsedMs: 15_000, remainingMs: 585_000, sourceFiles: 8_741,
    classpathEntries: 1_686, pendingRoots: 1, heapXmx: '6G', processId: 4321,
    classpathReadiness: {
      attempts: 7, totalRoots: 1, completedRoots: 0, currentRootId: 'bazel:.',
      expectedEntries: 1_686, classpathEntries: 1_600, modulepathEntries: 20,
      actualEntries: 1_620, matchedEntries: 1_610, missingEntries: 76,
      rootProgressPercent: 0, entryProgressPercent: 95.49, stalledForMs: 15_000,
    },
    jdtProgress: [{ token: 'index-1', task: 'Indexing', message: 'Resolving types', percentage: 42, idleForMs: 15_000 }],
    activeJdtTasks: 1,
    nodeRssMiB: events[2].nodeRssMiB, jdtRssMiB: 512.25,
  });
  now = telemetry.deadlineAt + 1;
  assert.throws(() => telemetry.remainingMs('project-import'), /deadline exceeded during project-import/);
});

test('classpath validation counts classpath and modulepath entries and reports request progress', async () => {
  let requestedUri: string | undefined;
  const progress: Array<{
    matchedEntries: number; missingEntries: number; completedRoots: number;
    requestState?: string;
  }> = [];
  const adapter = {
    documentUri: (filename: string) => `file://${filename}`,
    request: async (_method: string, params: unknown) => {
      requestedUri = ((params as { arguments?: unknown[] }).arguments?.[0] as string | undefined);
      return {
        classpaths: ['/deps/runtime.jar'], modulepaths: ['/deps/module.jar'], projectRoot: 'file:///workspace/project',
      };
    },
  } as unknown as ILspAdapter;
  await validateImportedJavaProjectClasspaths(
    adapter,
    [{
      buildRootId: 'bazel:.', projectName: 'project', buildRootPath: '/workspace',
      sourcePaths: [], generatedSourcePaths: [], sourceMappings: [], sourceLayout: 'linked',
      consolidatedSourceRoots: [], uriAliases: [], compileClasspath: [], runtimeClasspath: [],
      languageServerClasspath: ['/deps/runtime.jar', '/deps/module.jar'], buildSystems: ['bazel'],
      modelSource: 'bazel-java-info', projectImportMode: 'external-eclipse',
      eclipseProjectPath: '/generated/projects/project', representativeDocumentPath: '/workspace/App.java',
    }],
    'jdtls-shard-1',
    Date.now() + 1_000,
    undefined,
    (event) => progress.push(event),
  );
  assert.deepEqual(progress.map(({ matchedEntries, missingEntries, completedRoots, requestState, projectRoot }) => ({
    matchedEntries, missingEntries, completedRoots, requestState, projectRoot,
  })), [
    { matchedEntries: 0, missingEntries: 2, completedRoots: 0, requestState: 'sent', projectRoot: undefined },
    {
      matchedEntries: 2, missingEntries: 0, completedRoots: 1,
      requestState: 'returned', projectRoot: '/workspace/project',
    },
  ]);
  assert.equal(requestedUri, pathToFileURL('/generated/projects/project').href);
});

test('classpath validation retries only while coverage improves and backs off between stable responses', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const responses = [
    { classpaths: ['/deps/one.jar'], modulepaths: [] },
    { classpaths: ['/deps/one.jar', '/deps/two.jar'], modulepaths: [] },
  ];
  const adapter = {
    documentUri: (filename: string) => `file://${filename}`,
    request: async () => responses.shift(),
  } as unknown as ILspAdapter;
  await validateImportedJavaProjectClasspaths(
    adapter,
    [readinessProject(['/deps/one.jar', '/deps/two.jar'])],
    'jdtls-shard-1',
    10_000,
    undefined,
    undefined,
    {
      now: () => now,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
      stallTimeoutMs: 2_000,
      initialPollMs: 250,
      maxPollMs: 1_000,
    },
  );
  assert.deepEqual(sleeps, [250]);
});

test('classpath validation fails a stable mismatch with bounded missing-entry diagnostics', async () => {
  let now = 0;
  let requests = 0;
  const adapter = {
    documentUri: (filename: string) => `file://${filename}`,
    request: async () => {
      requests += 1;
      return { classpaths: ['/deps/one.jar'], modulepaths: [] };
    },
  } as unknown as ILspAdapter;
  await assert.rejects(
    validateImportedJavaProjectClasspaths(
      adapter,
      [readinessProject(['/deps/one.jar', '/deps/missing.jar'])],
      'jdtls-shard-1',
      10_000,
      undefined,
      undefined,
      {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
        stallTimeoutMs: 2_000,
        initialPollMs: 250,
        maxPollMs: 1_000,
      },
    ),
    /stopped progressing.*1\/2 Bazel entries are missing.*\/deps\/missing\.jar/,
  );
  assert.equal(requests, 5);
  assert.equal(now, 2_000);
});

test('classpath validation surfaces repeated JDT request failures instead of waiting for the startup deadline', async () => {
  let now = 0;
  let requests = 0;
  const adapter = {
    documentUri: (filename: string) => `file://${filename}`,
    request: async () => {
      requests += 1;
      throw new Error('project is unavailable');
    },
  } as unknown as ILspAdapter;
  await assert.rejects(
    validateImportedJavaProjectClasspaths(
      adapter,
      [readinessProject(['/deps/one.jar'])],
      'jdtls-shard-1',
      10_000,
      undefined,
      undefined,
      {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
        maxConsecutiveErrors: 3,
        initialPollMs: 250,
        maxPollMs: 1_000,
      },
    ),
    /failed 3 consecutive times.*project is unavailable/,
  );
  assert.equal(requests, 3);
  assert.equal(now, 750);
});

test('classpath validation tolerates a transient non-existing project during native import', async () => {
  let now = 0;
  let requests = 0;
  const adapter = {
    documentUri: (filename: string) => `file://${filename}`,
    request: async () => {
      requests += 1;
      if (requests <= 4) {
        throw new Error('Launch configuration 123 references non-existing project spring-sample.');
      }
      return { classpaths: ['/deps/one.jar'], modulepaths: [] };
    },
  } as unknown as ILspAdapter;
  await validateImportedJavaProjectClasspaths(
    adapter,
    [readinessProject(['/deps/one.jar'])],
    'jdtls-shard-1',
    10_000,
    undefined,
    undefined,
    {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      stallTimeoutMs: 5_000,
      maxConsecutiveErrors: 3,
      initialPollMs: 250,
      maxPollMs: 1_000,
    },
  );
  assert.equal(requests, 5);
  assert.equal(now, 2_750);
});

function readinessProject(languageServerClasspath: string[]) {
  return {
    buildRootId: 'bazel:.', projectName: 'project', buildRootPath: '/workspace',
    sourcePaths: [], generatedSourcePaths: [], sourceMappings: [], sourceLayout: 'linked' as const,
    consolidatedSourceRoots: [], uriAliases: [], compileClasspath: [], runtimeClasspath: [],
    languageServerClasspath, buildSystems: ['bazel'],
    modelSource: 'bazel-java-info' as const, representativeDocumentPath: '/workspace/App.java',
  };
}

test('retains bounded language-server stderr for startup diagnostics', () => {
  const adapter = new DiagnosticStdioAdapter();
  adapter.feedStderr(`discard-me-${'x'.repeat(70_000)}-diagnostic-tail`);
  const error = adapter.startupError('startup failed');
  assert.match(error.message, /startup failed/);
  assert.match(error.message, /diagnostic-tail/);
  assert.doesNotMatch(error.message, /discard-me/);
  const metadata = adapter.getSessionMetadata();
  assert.ok((metadata.processStderrTail?.length ?? 0) <= 64 * 1024);
  assert.match(metadata.processStderrTail ?? '', /diagnostic-tail$/);
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
