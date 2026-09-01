import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLspKnowledgeGraphBuildOptions } from '../src/pipeline/cli-options.js';
import { mapConcurrently } from '../src/pipeline/concurrency.js';
import { addConfiguredJavaSources, findJavaSourceFiles } from '../src/pipeline/java-source-files.js';
import { parseBazelPreparationCommandOptions } from '../src/cli/bazel-prepare.js';
import {
  fingerprintPipelineInputs,
  PipelineCheckpointStore,
} from '../src/pipeline/checkpoints.js';
import {
  openLspLadybugDatabase,
  type LadybugModuleLike,
} from '../src/lbug/repository.js';

test('bounds the default LadybugDB buffer pool at one GiB and accepts an override', async (t) => {
  const original = process.env.GITNEXUS_LBUG_BUFFER_POOL_MB;
  t.after(() => {
    if (original === undefined) delete process.env.GITNEXUS_LBUG_BUFFER_POOL_MB;
    else process.env.GITNEXUS_LBUG_BUFFER_POOL_MB = original;
  });
  let bufferManagerSize = -1;
  class FakeDatabase {
    constructor(_databasePath: string, size = -1) { bufferManagerSize = size; }
  }
  class FakeConnection {
    constructor(_database: FakeDatabase) {}
  }
  const ladybug = {
    Database: FakeDatabase,
    Connection: FakeConnection,
  } as unknown as LadybugModuleLike;

  delete process.env.GITNEXUS_LBUG_BUFFER_POOL_MB;
  await openLspLadybugDatabase('/tmp/default-pool.lbug', ladybug).close();
  assert.equal(bufferManagerSize, 1_024 * 1024 * 1024);

  process.env.GITNEXUS_LBUG_BUFFER_POOL_MB = '512';
  await openLspLadybugDatabase('/tmp/override-pool.lbug', ladybug).close();
  assert.equal(bufferManagerSize, 512 * 1024 * 1024);
});

test('parses knowledge-graph build options with explicit artifact manifests', () => {
  const options = parseLspKnowledgeGraphBuildOptions([
    'build-index',
    '/workspace',
    '--concurrency',
    '3',
    '--artifact-max-classes',
    '50',
    '--artifact-concurrency',
    '6',
    '--artifact-classpath-manifest',
    '/manifests/artifacts.json',
    '--no-artifact-source-fetch',
    '--checkpoint-directory',
    '/checkpoints/run-1',
    '--build-model-mode',
    'prepared',
    '--bazel-target-query',
    'set(//service:lib //shared:api)',
  ]);
  assert.equal(options.workspace, '/workspace');
  assert.equal(options.concurrency, 3);
  assert.equal(options.artifactMaxClasses, 50);
  assert.equal(options.artifactConcurrency, 6);
  assert.deepEqual(options.artifactManifestPaths, ['/manifests/artifacts.json']);
  assert.equal(options.fetchArtifactSources, false);
  assert.equal(options.checkpointDirectory, '/checkpoints/run-1');
  assert.equal(options.resume, true);
  assert.equal(options.crawlProfile, 'exhaustive');
  assert.equal(options.bazelBuildMode, 'prebuilt');
  assert.equal(options.bazelTargetQuery, 'set(//service:lib //shared:api)');
});

test('defaults to resumable checkpoints beside the requested output', () => {
  const options = parseLspKnowledgeGraphBuildOptions([
    'build', '/workspace', '--output', '/tmp/result.lbug', '--no-resume',
  ]);
  assert.equal(options.checkpointDirectory, '/tmp/result.lbug.checkpoints');
  assert.equal(options.resume, false);
  assert.equal(options.crawlProfile, 'exhaustive');
  assert.equal(options.bazelBuildMode, 'managed');
});

test('writes atomic checkpoints and rejects incompatible input fingerprints', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-checkpoints-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const input = path.join(workspace, 'Example.java');
  fs.writeFileSync(input, 'class Example {}');
  const fingerprint = fingerprintPipelineInputs(workspace, [input], { language: 'java' });
  const store = new PipelineCheckpointStore(path.join(workspace, 'checkpoints'));
  store.save('lsp-crawl', fingerprint, { symbols: [1, 2, 3] });
  assert.deepEqual(store.load('lsp-crawl', fingerprint), { symbols: [1, 2, 3] });
  assert.equal(store.load('lsp-crawl', 'different'), undefined);
  assert.deepEqual(fs.readdirSync(store.directory), ['lsp-crawl.checkpoint']);
});

test('retains only the latest content-addressed crawl ID and reuses its exact identity', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-crawl-cache-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const store = new PipelineCheckpointStore(path.join(workspace, 'checkpoints'));
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  store.saveCached('lsp-crawl', first, { symbols: ['first'] });
  store.saveCached('lsp-crawl', second, { symbols: ['second'] });
  assert.equal(store.loadCached('lsp-crawl', first), undefined);
  assert.deepEqual(store.loadCached('lsp-crawl', second), { symbols: ['second'] });
  assert.equal(store.loadCached('lsp-crawl', 'c'.repeat(64)), undefined);
  assert.deepEqual(
    fs.readdirSync(path.join(store.directory, 'by-id', 'lsp-crawl')).sort(),
    [`${second}.checkpoint`],
  );
});

test('bounds content-addressed checkpoints and removes resumability-only root stages', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bounded-cache-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const store = new PipelineCheckpointStore(path.join(workspace, 'checkpoints'));
  const ids = ['a', 'b', 'c'].map((value) => value.repeat(64));
  for (const id of ids) store.saveCached('lsp-crawl', id, { id });
  assert.deepEqual(
    fs.readdirSync(path.join(store.directory, 'by-id', 'lsp-crawl')).sort(),
    [`${ids[2]}.checkpoint`],
  );
  const rootStage = store.rootStage('bazel:.');
  store.saveCached(rootStage, ids[2]!, { root: true });
  store.removeCachedStage(rootStage);
  assert.equal(fs.existsSync(path.join(store.directory, 'by-id', rootStage)), false);
});

test('rejects flags that omit their required value', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--output']),
    /--output requires a value/,
  );
});

test('rejects the removed crawl-planner option', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--crawl-planner', 'legacy']),
    /Unknown argument --crawl-planner/,
  );
});

test('rejects unknown build-model modes', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build-index', '/workspace', '--build-model-mode', 'scan-output']),
    /--build-model-mode must be one of integrated, prepared/,
  );
});

test('parses isolated Bazel preparation command options', () => {
  assert.deepEqual(parseBazelPreparationCommandOptions([
    '/workspace', '--concurrency', '2', '--timeout-ms', '9000',
    '--bazel-target-query', 'set(//service:lib)',
  ]), {
    workspace: '/workspace', concurrency: 2, timeoutMs: 9000,
    targetQuery: 'set(//service:lib)',
  });
});

test('maps work with bounded concurrency while retaining input order', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrently([3, 1, 2, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [30, 10, 20, 40]);
  assert.equal(peak, 2);
});

test('discovers Java sources but excludes generated build directories', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-java-sources-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'src/main/java/Example.java');
  const generated = path.join(workspace, 'build/generated/Generated.java');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(source, 'class Example {}');
  fs.writeFileSync(generated, 'class Generated {}');
  assert.deepEqual(findJavaSourceFiles(workspace), [source]);
});

test('adds configured generated Java to an otherwise empty Bazel root', () => {
  const generated = path.resolve('/execution-root/bazel-out/generated/Only.java');
  const files = addConfiguredJavaSources(new Map(), [{
    rootId: 'bazel:.',
    status: 'generated',
    crawlSources: [{
      path: generated,
      analysisPath: generated,
      origin: 'generated',
      contentHash: 'hash',
      targetLabels: ['//:generated'],
      originalRepositoryPaths: [],
      configuredSourceAssociations: [{ path: generated, targetLabels: ['//:generated'] }],
      sourceJarAssociations: [],
    }],
  }]);
  assert.deepEqual(files.get('bazel:.'), [generated]);
});
