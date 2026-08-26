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

test('parses knowledge-graph build options with explicit artifact manifests', () => {
  const options = parseLspKnowledgeGraphBuildOptions([
    'build',
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
    '--crawl-planner',
    'facts-first',
    '--bazel-build-mode',
    'prebuilt',
  ]);
  assert.equal(options.workspace, '/workspace');
  assert.equal(options.concurrency, 3);
  assert.equal(options.artifactMaxClasses, 50);
  assert.equal(options.artifactConcurrency, 6);
  assert.deepEqual(options.artifactManifestPaths, ['/manifests/artifacts.json']);
  assert.equal(options.fetchArtifactSources, false);
  assert.equal(options.checkpointDirectory, '/checkpoints/run-1');
  assert.equal(options.resume, true);
  assert.equal(options.crawlPlanner, 'facts-first');
  assert.equal(options.bazelBuildMode, 'prebuilt');
});

test('defaults to resumable checkpoints beside the requested output', () => {
  const options = parseLspKnowledgeGraphBuildOptions([
    'build', '/workspace', '--output', '/tmp/result.lbug', '--no-resume',
  ]);
  assert.equal(options.checkpointDirectory, '/tmp/result.lbug.checkpoints');
  assert.equal(options.resume, false);
  assert.equal(options.crawlPlanner, 'legacy');
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

test('rejects flags that omit their required value', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--output']),
    /--output requires a value/,
  );
});

test('rejects unknown crawl planners', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--crawl-planner', 'canonical']),
    /--crawl-planner must be one of legacy, facts-first/,
  );
});

test('rejects unknown Bazel build modes', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--bazel-build-mode', 'scan-output']),
    /--bazel-build-mode must be one of managed, prebuilt/,
  );
});

test('parses isolated Bazel preparation command options', () => {
  assert.deepEqual(parseBazelPreparationCommandOptions([
    '/workspace', '--concurrency', '2', '--timeout-ms', '9000',
  ]), {
    workspace: '/workspace', concurrency: 2, timeoutMs: 9000,
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
