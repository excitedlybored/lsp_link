import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { crawlJvmArtifacts } from '../dist/artifact/crawler.js';
import { BazelJavaInfoClasspathProvider } from '../dist/artifact/classpath-provider.js';
import { JvmArtifactRepository } from '../dist/artifact/repository.js';
import { JVM_ARTIFACT_SCHEMA_QUERIES } from '../dist/artifact/schema.js';

test('runs artifact enrichment separately, downloads sources, and preserves bytecode call sites', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-jvm-artifact-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sourceRoot = path.join(fixture, 'source');
  const classes = path.join(fixture, 'classes');
  fs.mkdirSync(path.join(sourceRoot, 'com/example'), { recursive: true });
  fs.mkdirSync(classes, { recursive: true });
  const javaFile = path.join(sourceRoot, 'com/example/TestDep.java');
  fs.writeFileSync(javaFile, [
    'package com.example;',
    'public class TestDep {',
    '  public static String target() { return "ok"; }',
    '  public static String caller() { return target(); }',
    '}',
  ].join('\n'));
  execFileSync('javac', ['-d', classes, javaFile]);

  const sourcesJar = path.join(fixture, 'demo-1.0-sources.jar');
  execFileSync('jar', ['cf', sourcesJar, '-C', sourceRoot, '.']);
  const sourcesBytes = fs.readFileSync(sourcesJar);
  const server = http.createServer((request, response) => {
    if (request.url === '/maven2/com/example/demo/1.0/demo-1.0-sources.jar') {
      response.writeHead(200, { 'content-type': 'application/java-archive' });
      response.end(sourcesBytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');

  const jarDirectory = path.join(
    fixture, 'cache/v1/http', `127.0.0.1:${address.port}`,
    'maven2/com/example/demo/1.0',
  );
  fs.mkdirSync(jarDirectory, { recursive: true });
  const binaryJar = path.join(jarDirectory, 'processed_demo-1.0.jar');
  const headerJar = path.join(jarDirectory, 'header_demo-1.0.jar');
  execFileSync('jar', ['cf', binaryJar, '-C', classes, '.']);
  fs.copyFileSync(binaryJar, headerJar);
  const modelDirectory = path.join(fixture, '.gitnexus/jdtls');
  fs.mkdirSync(modelDirectory, { recursive: true });
  const modelPath = path.join(modelDirectory, 'bazel-project.json');
  fs.writeFileSync(modelPath, JSON.stringify({ classpath: [headerJar] }));
  const descriptors = await new BazelJavaInfoClasspathProvider().resolve({
    root: { id: 'root:test', workspacePath: fixture, systems: ['bazel'] },
    documentUris: [], bazelModelPath: modelPath,
  });

  const uri = 'jdt://contents/header_demo-1.0.jar/com/example/TestDep.java?=demo-1.0.jar';
  const batch = await crawlJvmArtifacts({
    lspRunId: 'run:test',
    artifacts: descriptors,
    cacheDirectory: modelDirectory,
    lspBatch: emptyLspBatch(uri),
    fetchSources: true,
  });

  assert.equal(batch.runs[0].status, 'complete', JSON.stringify(batch.runs[0]));
  assert.equal(batch.artifacts.length, 1);
  assert.equal(batch.artifacts[0].coordinate, 'com.example:demo:1.0');
  assert.equal(batch.artifacts[0].associationStatus, 'complete');
  assert.equal(batch.artifacts[0].sourceOrigin, 'downloaded');
  assert.deepEqual(batch.artifacts[0].classpathProviders, ['bazel-java-info']);
  assert.ok(fs.existsSync(batch.artifacts[0].sourceJarPath));
  assert.ok(batch.classes.some((value) => value.binaryName === 'com.example.TestDep' && value.isSeed));
  assert.ok(batch.methods.some((value) => value.name === 'caller' && value.hasCode));
  assert.ok(batch.callSites.some((value) =>
    value.targetOwner === 'com.example.TestDep' && value.targetName === 'target' && value.status === 'resolved'));
  assert.ok(batch.relations.some((value) => value.kind === 'BYTECODE_RESOLVES_TO'));
});

test('uses a physically separate Ladybug schema and repository transaction', async () => {
  assert.ok(JVM_ARTIFACT_SCHEMA_QUERIES.some((ddl) => ddl.includes('JvmArtifactEnrichmentRun')));
  assert.ok(JVM_ARTIFACT_SCHEMA_QUERIES.some((ddl) => ddl.includes('CREATE REL TABLE JvmRelation')));
  assert.ok(JVM_ARTIFACT_SCHEMA_QUERIES.every((ddl) => !ddl.includes('LspRelation')));

  const connection = new RecordingConnection();
  const repository = new JvmArtifactRepository(connection);
  await repository.initializeSchema();
  assert.deepEqual(connection.queries, [...JVM_ARTIFACT_SCHEMA_QUERIES]);
});

function emptyLspBatch(uri) {
  return {
    analysisRuns: [], servers: [], buildRoots: [], documents: [], symbols: [], callSites: [],
    occurrences: [{ uri }], hovers: [], diagnostics: [], semanticTokens: [], signatureHelps: [],
    signatures: [], parameters: [], coverage: [], evidence: [], relations: [],
  };
}

class RecordingConnection {
  queries = [];
  async query(cypher) { this.queries.push(cypher); return { close() {} }; }
  async prepare() { return { isSuccess: () => true }; }
  async execute() { return { close() {} }; }
}
