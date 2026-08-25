import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLspKnowledgeGraphBuildOptions } from '../src/pipeline/cli-options.js';
import { mapConcurrently } from '../src/pipeline/concurrency.js';
import { findJavaSourceFiles } from '../src/pipeline/java-source-files.js';

test('parses knowledge-graph build options with explicit artifact manifests', () => {
  const options = parseLspKnowledgeGraphBuildOptions([
    'build',
    '/workspace',
    '--concurrency',
    '3',
    '--artifact-max-classes',
    '50',
    '--artifact-classpath-manifest',
    '/manifests/artifacts.json',
    '--no-artifact-source-fetch',
  ]);
  assert.equal(options.workspace, '/workspace');
  assert.equal(options.concurrency, 3);
  assert.equal(options.artifactMaxClasses, 50);
  assert.deepEqual(options.artifactManifestPaths, ['/manifests/artifacts.json']);
  assert.equal(options.fetchArtifactSources, false);
});

test('rejects flags that omit their required value', () => {
  assert.throws(
    () => parseLspKnowledgeGraphBuildOptions(['build', '/workspace', '--output']),
    /--output requires a value/,
  );
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
