import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { globSync } from 'glob';
import lbug from '@ladybugdb/core';

import { enrichJvmArtifacts } from '../dist/artifact/enrichment.js';
import { AsmArtifactWorker } from '../dist/artifact/asm-worker.js';
import { BazelJavaInfoClasspathProvider } from '../dist/artifact/classpath/index.js';
import { JvmArtifactRepository } from '../dist/artifact/repository.js';
import { JVM_ARTIFACT_SCHEMA_QUERIES } from '../dist/artifact/schema.js';
import { openLspLadybugDatabase } from '../dist/lbug/repository.js';
import { streamJvmArtifacts } from '../dist/artifact/streaming-enrichment.js';
import { ArtifactBulkSpoolSink, bulkCopyArtifactGraph } from '../dist/artifact/bulk-copy.js';
import { persistStreamingKnowledgeGraph } from '../dist/artifact/streaming-persistence.js';
import { bulkCopyBaseGraph } from '../dist/artifact/base-graph-bulk-copy.js';
import { BulkCsvFiles } from '../dist/artifact/bulk-copy-support.js';
import { PipelineCheckpointStore } from '../dist/pipeline/checkpoints.js';

test('buffers bounded CSV fragments without losing interleaved rows', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-bulk-csv-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const csv = new BulkCsvFiles(fixture, 2);
  csv.row('Node', ['one', 1]);
  csv.row('Other', ['separate']);
  csv.row('Node', ['two', 2]);
  csv.row('Node', ['three', 3]);
  csv.close();

  assert.equal(csv.paths('Node').length, 2);
  assert.equal(fs.readFileSync(csv.paths('Node')[0], 'utf8'), '"one","1"\n"two","2"\n');
  assert.equal(fs.readFileSync(csv.paths('Node')[1], 'utf8'), '"three","3"\n');
  assert.equal(fs.readFileSync(csv.paths('Other')[0], 'utf8'), '"separate"\n');
});

test('negotiates one persistent ASM worker without javap', async () => {
  const worker = new AsmArtifactWorker(2);
  const info = await worker.start();
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.provider, 'asm');
  assert.equal(info.providerVersion, '9.9.1');
  assert.equal(info.concurrency, 2);
  assert.equal(info.minimumClassFileMajor, 45);
  assert.ok(info.maximumClassFileMajor >= 65);
  await worker.close();
});

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
    'import java.lang.annotation.Retention;',
    'import java.lang.annotation.RetentionPolicy;',
    'import java.util.function.Supplier;',
    '@Retention(RetentionPolicy.CLASS) @interface ClassOnly {}',
    'interface Contract { String run(); }',
    'class Parent { protected String inherited() { return "parent"; } }',
    'record Item(int value) {}',
    'enum Mode { ACTIVE }',
    '@Deprecated @ClassOnly public class TestDep extends Parent implements Contract {',
    '  public String field;',
    '  public TestDep() { super(); }',
    '  public static String target() { return "ok"; }',
    '  @Deprecated public static String caller() { return target().trim(); }',
    '  public String run() { return inherited(); }',
    '  public static String interfaceCall(Contract value) { return value.run(); }',
    '  public static Supplier<String> lambda() { return () -> target(); }',
    '}',
  ].join('\n'));
  execFileSync(jdkTool('javac'), ['-d', classes, javaFile]);

  const sourcesJar = path.join(fixture, 'demo-1.0-sources.jar');
  execFileSync(jdkTool('jar'), ['cf', sourcesJar, '-C', sourceRoot, '.']);
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
  execFileSync(jdkTool('jar'), ['cf', binaryJar, '-C', classes, '.']);
  const multiReleaseClasses = path.join(fixture, 'multi-release');
  const versionedClass = path.join(multiReleaseClasses, 'META-INF/versions/11/com/example/TestDep.class');
  fs.mkdirSync(path.dirname(versionedClass), { recursive: true });
  fs.copyFileSync(path.join(classes, 'com/example/TestDep.class'), versionedClass);
  execFileSync(jdkTool('jar'), ['uf', binaryJar, '-C', multiReleaseClasses, '.']);
  fs.copyFileSync(binaryJar, headerJar);
  const modelDirectory = path.join(fixture, '.gitnexus/jdtls');
  fs.mkdirSync(modelDirectory, { recursive: true });
  const modelPath = path.join(modelDirectory, 'bazel-project.json');
  fs.writeFileSync(modelPath, JSON.stringify({ classpath: [headerJar] }));
  const descriptors = await new BazelJavaInfoClasspathProvider().resolveArtifacts({
    root: { id: 'root:test', workspacePath: fixture, systems: ['bazel'] },
    documentUris: [], bazelModelPath: modelPath,
    loadJdtRuntimeClasspath: async () => [],
  });

  const uri = 'jdt://contents/header_demo-1.0.jar/com/example/TestDep.java?=demo-1.0.jar';
  const forbiddenBin = path.join(fixture, 'forbidden-bin');
  const javapMarker = path.join(fixture, 'javap-was-launched');
  fs.mkdirSync(forbiddenBin);
  const fakeJavap = path.join(forbiddenBin, process.platform === 'win32' ? 'javap.cmd' : 'javap');
  fs.writeFileSync(fakeJavap, process.platform === 'win32'
    ? `@echo launched>${javapMarker}\r\n@exit /b 99\r\n`
    : `#!/bin/sh\nprintf launched > '${javapMarker}'\nexit 99\n`);
  fs.chmodSync(fakeJavap, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${forbiddenBin}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => { process.env.PATH = originalPath; });
  const enrichmentProgress = [];
  const batch = await enrichJvmArtifacts({
    lspRunId: 'run:test',
    artifacts: descriptors,
    cacheDirectory: modelDirectory,
    lspBatch: emptyLspBatch(uri),
    fetchSources: true,
    onProgress: (value) => enrichmentProgress.push(value),
  });

  assert.equal(batch.runs[0].status, 'complete', JSON.stringify(batch.runs[0]));
  assert.equal(batch.artifacts.length, 1);
  assert.equal(batch.artifacts[0].coordinate, 'com.example:demo:1.0');
  assert.equal(batch.artifacts[0].associationStatus, 'complete');
  assert.equal(batch.artifacts[0].sourceOrigin, 'downloaded');
  assert.deepEqual(batch.artifacts[0].classpathProviders, ['bazel-java-info']);
  assert.ok(fs.existsSync(batch.artifacts[0].sourceJarPath));
  assert.ok(batch.classes.some((value) => value.binaryName === 'com.example.TestDep' && value.isSeed));
  assert.ok(batch.classes.every((value) => !value.binaryName.startsWith('META-INF.versions.')));
  assert.ok(batch.classes.some((value) =>
    value.binaryName === 'com.example.TestDep'
      && value.annotations.includes('java.lang.Deprecated')
      && value.annotations.includes('com.example.ClassOnly')));
  assert.ok(batch.classes.some((value) => value.binaryName === 'com.example.Contract' && value.kind === 'interface'));
  assert.ok(batch.classes.some((value) => value.binaryName === 'com.example.Item' && value.kind === 'record'));
  assert.ok(batch.classes.some((value) => value.binaryName === 'com.example.Mode' && value.kind === 'enum'));
  assert.ok(batch.fields.some((value) => value.owner === 'com.example.TestDep' && value.name === 'field'));
  assert.ok(batch.methods.some((value) =>
    value.name === 'caller' && value.hasCode && value.annotations.includes('java.lang.Deprecated')));
  assert.ok(batch.callSites.some((value) =>
    value.targetOwner === 'com.example.TestDep' && value.targetName === 'target' && value.status === 'resolved'));
  assert.ok(batch.relations.some((value) => value.kind === 'BYTECODE_RESOLVES_TO'));
  assert.ok(batch.relations.some((value) => value.kind === 'BYTECODE_SUPERCLASS'));
  assert.ok(batch.relations.some((value) => value.kind === 'BYTECODE_INTERFACE'));
  assert.deepEqual(
    new Set(batch.callSites.map((value) => value.opcode)),
    new Set(['invokespecial', 'invokestatic', 'invokevirtual', 'invokeinterface', 'invokedynamic']),
  );
  assert.ok(batch.callSites.some((value) => value.bytecodeOffset > 1),
    'call sites retain real bytecode offsets rather than invocation ordinals');
  const legacyGolden = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures/artifact-legacy-golden.json'), 'utf8',
  ));
  for (const expected of legacyGolden.classes) assert.ok(batch.classes.some((value) =>
    value.binaryName === expected.binaryName && value.kind === expected.kind));
  for (const method of legacyGolden.methods) assert.ok(batch.methods.some((value) => value.name === method));
  for (const field of legacyGolden.fields) assert.ok(batch.fields.some((value) => value.name === field));
  for (const annotation of legacyGolden.annotations) assert.ok(batch.classes.some((value) =>
    value.annotations.includes(annotation)));
  for (const opcode of legacyGolden.invocationOpcodes) assert.ok(batch.callSites.some((value) =>
    value.opcode === opcode));
  assert.ok(batch.bindings.some((value) =>
    value.sourceId === 'hover:test' && value.targetKind === 'JvmClass' && value.kind === 'HOVER_TARGET'));
  assert.equal(enrichmentProgress.at(-1).completedClasses, 6,
    'referenced JDK classes must not escape the artifact-class queue');

  const capped = await enrichJvmArtifacts({
    lspRunId: 'run:capped', artifacts: descriptors, cacheDirectory: modelDirectory,
    lspBatch: emptyLspBatch(uri), fetchSources: false, maxDisassembledClasses: 2,
  });
  assert.equal(capped.runs[0].status, 'partial');
  assert.equal(capped.runs[0].truncated, true);
  assert.equal(capped.classes.length, 6, 'a cap does not filter the artifact class inventory');
  assert.ok(capped.methods.some((value) => value.owner === 'com.example.TestDep'));
  assert.ok(capped.methods.some((value) => value.owner === 'com.example.Parent'),
    'capped traversal follows bytecode targets and may reopen the owning JAR');
  assert.ok(!capped.methods.some((value) =>
    value.owner === 'com.example.Contract' && !value.isExternalPlaceholder),
    'the global class cap bounds transitive detail parsing');
  assert.ok(!fs.existsSync(javapMarker), 'artifact enrichment must never launch javap');
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

test('bulk-copies spooled ASM facts with graph parity and no duplicate nodes', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-bulk-copy-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const jar = path.resolve(
    import.meta.dirname, '../../vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar',
  );
  const input = {
    lspRunId: 'run:bulk-copy', cacheDirectory: fixture, lspBatch: emptyLspBatch(''),
    fetchSources: false,
    artifacts: [{
      buildRootId: 'root:test', providerIds: ['explicit-manifest'], scope: 'compile',
      modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
    }],
  };
  const expected = await enrichJvmArtifacts(input);
  const spool = path.join(fixture, 'spool');
  const completed = new Set();
  const interrupted = new ArtifactBulkSpoolSink(
    spool,
    async () => { throw new Error('simulated interruption before bulk publication'); },
    async (artifact) => completed.add(artifact.id),
  );
  await assert.rejects(streamJvmArtifacts(input, interrupted), /simulated interruption/);
  assert.equal(completed.size, 1, 'completed artifact spool is checkpointable before publication');
  const databasePath = path.join(fixture, 'bulk.lbug');
  const handle = openLspLadybugDatabase(databasePath, lbug);
  await handle.repository.initializeSchema();
  await handle.artifactRepository.initializeSchema();
  const sink = new ArtifactBulkSpoolSink(spool, async (
    initialization, finalBatch, spoolFiles, run,
  ) => bulkCopyArtifactGraph(
    handle.artifactRepository.connectionForBulkCopy(), initialization, finalBatch,
    spoolFiles, run, path.join(fixture, 'copy-work'),
  ));
  const resumed = await streamJvmArtifacts(input, sink, completed);
  assert.equal(resumed.run.classCount, expected.runs[0].classCount,
    'resumed run totals include artifacts restored from completed spools');
  assert.equal(resumed.run.methodCount, expected.runs[0].methodCount);
  assert.equal(resumed.run.callSiteCount, expected.runs[0].callSiteCount);
  const counts = await artifactCounts(handle);
  assert.deepEqual(counts, {
    classes: expected.classes.length,
    methods: expected.methods.length,
    callSites: expected.callSites.length,
  });
  const distinct = await handle.artifactRepository.connectionForBulkCopy().query(
    'MATCH (c:JvmClass) RETURN count(c) AS total, count(DISTINCT c.id) AS distinctIds',
  );
  assert.deepEqual(await distinct.getAll(), [{ total: expected.classes.length, distinctIds: expected.classes.length }]);
  await distinct.close();
  await handle.close();
});

test('rolls back an incomplete spool attempt before replay', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-spool-replay-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  let publishedFiles = [];
  const sink = new ArtifactBulkSpoolSink(fixture, async (_initial, _final, files) => {
    publishedFiles = files;
  });
  const batch = {
    runs: [], artifacts: [], resolutions: [], binaryReferences: [], binaryReferenceRelations: [],
    classes: [{
      id: 'class:one', stageId: 'stage', artifactId: 'artifact:one', binaryName: 'example.One',
      packageName: 'example', simpleName: 'One', kind: 'class', interfaces: [], isSeed: false,
      seedUris: [], wasDisassembled: true, annotations: [],
    }],
    methods: [], fields: [], callSites: [], relations: [], bindings: [],
  };
  const artifact = {
    id: 'artifact:one', stageId: 'stage', buildRootIds: ['root'],
    classpathProviders: ['explicit-manifest'], classpathScopes: ['compile'], modulePath: false,
    classpathEntryPath: '/tmp/one.jar', binaryJarPath: '/tmp/one.jar', sourceOrigin: 'unavailable',
    associationStatus: 'binary_only', classCount: 1, methodCount: 0, fieldCount: 0,
    callSiteCount: 0, contentHash: 'hash', classpathOrdinal: 0, processingStatus: 'complete',
    errorCount: 0, completedAt: new Date().toISOString(),
  };
  await sink.initialize({
    id: 'stage', lspRunId: 'run', status: 'running', startedAt: new Date().toISOString(),
    provider: 'asm', classpathProviders: [], classpathResolutionJson: '[]', classpathErrorCount: 0,
    artifactCount: 1, classCount: 0, methodCount: 0, fieldCount: 0, callSiteCount: 0,
    errorCount: 0, truncated: false,
  }, { ...batch, classes: [], artifacts: [artifact] });
  await sink.beginArtifactAttempt(artifact.id);
  await sink.write(batch, artifact.id);
  await sink.rollbackArtifactAttempt(artifact.id);
  await sink.beginArtifactAttempt(artifact.id);
  await sink.write(batch, artifact.id);
  await sink.completeArtifact(artifact);
  await sink.finalize({
    id: 'stage', lspRunId: 'run', status: 'complete', startedAt: new Date().toISOString(),
    provider: 'asm', classpathProviders: [], classpathResolutionJson: '[]', classpathErrorCount: 0,
    artifactCount: 1, classCount: 1, methodCount: 0, fieldCount: 0, callSiteCount: 0,
    errorCount: 0, truncated: false,
  });
  assert.equal(publishedFiles.length, 1);
  assert.equal(fs.readFileSync(publishedFiles[0], 'utf8').trim().split('\n').length, 1,
    'failed-attempt batches are truncated before replay');
});

test('bulk-copies populated base graph families with endpoint and array parity', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-base-bulk-copy-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const handle = openLspLadybugDatabase(path.join(fixture, 'base.lbug'), lbug);
  await handle.repository.initializeSchema();
  await handle.callNormalizationRepository.initializeSchema();
  await handle.bazelBuildGraphRepository.initializeSchema();
  await handle.repositoryInventoryRepository.initializeSchema();

  const lspBatch = populatedBaseLspBatch();
  const normalization = {
    runs: [{
      id: 'normalize:run', lspRunId: 'run:base', status: 'complete', algorithmVersion: 'test-v1',
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
      observationCount: 0, invocationCount: 1, normalizedObservationCount: 0,
      ambiguousObservationCount: 0, errorCount: 0,
    }],
    invocations: [{
      id: 'invocation:one', stageId: 'normalize:run', runId: 'run:base', documentId: 'document:base',
      callerSymbolId: 'symbol:base', callerStableKey: 'caller', targetFamilyId: 'family:target',
      targetFamilyStableKey: 'target', startLine: 1, startCharacter: 2, endLine: 1,
      endCharacter: 8, observationCount: 1, directions: ['outgoing'],
      capabilities: ['callHierarchy/outgoingCalls'], stableKey: 'invocation', status: 'unresolved',
      confidence: 0.5, algorithmVersion: 'test-v1',
    }],
    relations: [{
      id: 'derived:has', sourceKind: 'DerivedCallNormalizationRun', sourceId: 'normalize:run',
      targetKind: 'LspLogicalInvocation', targetId: 'invocation:one',
      kind: 'HAS_LOGICAL_INVOCATION', stageId: 'normalize:run', confidence: 1, ordinal: 0,
    }],
  };
  const bazel = {
    runs: [{
      id: 'bazel:run', buildRootId: 'root:base', workspacePath: fixture, status: 'complete',
      targetCount: 1, sourceCount: 1, artifactCount: 1, relationCount: 3,
      resolvedTargetCount: 1, excludedTargetCount: 0, excludedTargetsJson: '[]', scopeWarningsJson: '[]',
    }],
    targets: [{ id: 'bazel:target', graphId: 'bazel:run', buildRootId: 'root:base', label: '//:base', selected: true, codeOrigin: 'repository' }],
    sources: [{ id: 'bazel:source', graphId: 'bazel:run', path: '/workspace/Base.kt', isGenerated: false, codeOrigin: 'repository' }],
    artifacts: [{ id: 'bazel:artifact', graphId: 'bazel:run', path: '/workspace/base.jar', codeOrigin: 'first_party_artifact' }],
    relations: [
      { id: 'bazel:r1', graphId: 'bazel:run', sourceKind: 'BazelBuildGraphRun', sourceId: 'bazel:run', targetKind: 'BazelTarget', targetId: 'bazel:target', kind: 'HAS_TARGET', ordinal: 0 },
      { id: 'bazel:r2', graphId: 'bazel:run', sourceKind: 'BazelTarget', sourceId: 'bazel:target', targetKind: 'BazelSource', targetId: 'bazel:source', kind: 'OWNS_SOURCE', ordinal: 0 },
      { id: 'bazel:r3', graphId: 'bazel:run', sourceKind: 'BazelTarget', sourceId: 'bazel:target', targetKind: 'BazelArtifact', targetId: 'bazel:artifact', kind: 'RUNTIME_ARTIFACT', ordinal: 0 },
    ],
  };
  const inventory = {
    runs: [{ id: 'inventory:run', workspacePath: fixture, status: 'complete', documentCount: 1, declarationCount: 1 }],
    providers: [{
      id: 'provider:run', runId: 'inventory:run', providerId: 'kotlin-source', providerVersion: '1',
      authority: 'structural_lexical', languages: ['kotlin'], capabilities: ['declarations'],
      includeGlobs: ['**/*.kt'], status: 'complete', discoveredCount: 1, indexedCount: 1,
      skippedCount: 0, errorCount: 0, errorsJson: '[]',
    }],
    documents: [{
      id: 'repository:document', runId: 'inventory:run', path: '/workspace/Base.kt', relativePath: 'Base.kt',
      languageId: 'kotlin', kind: 'source', contentHash: 'hash', byteSize: 12, lineCount: 1,
      codeOrigin: 'repository', providerId: 'kotlin-source', providerVersion: '1', authority: 'structural_lexical',
    }],
    declarations: [{
      id: 'repository:declaration', runId: 'inventory:run', documentId: 'repository:document',
      kind: 'class', name: 'Base', startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 10,
      providerId: 'kotlin-source', providerVersion: '1', authority: 'structural_lexical', codeOrigin: 'repository',
    }],
  };
  await bulkCopyBaseGraph(
    handle.repository.connectionForBulkCopy(), path.join(fixture, 'copy-work'),
    lspBatch, normalization, bazel, inventory,
  );
  const connection = handle.repository.connectionForBulkCopy();
  const counts = await connection.query(
    'MATCH (document:LspDocument)-[defines:LspRelation]->(symbol:LspClassSymbol) '
    + 'MATCH (target:BazelTarget)-[owns:BazelRelation]->(source:BazelSource) '
    + 'MATCH (repo:RepositoryDocument)-[declares:RepositoryInventoryRelation]->(declaration:RepositoryDeclaration) '
    + 'MATCH (normalization:DerivedCallNormalizationRun)-[has:DerivedCallRelation]->(invocation:LspLogicalInvocation) '
    + 'RETURN count(DISTINCT symbol) AS symbols, count(DISTINCT source) AS sources, '
    + 'count(DISTINCT declaration) AS declarations, count(DISTINCT invocation) AS invocations, '
    + 'symbol.tags AS symbolTags, invocation.directions AS directions, '
    + 'invocation.capabilities AS capabilities',
  );
  const [row] = await counts.getAll();
  await counts.close();
  assert.deepEqual({
    symbols: Number(row.symbols), sources: Number(row.sources),
    declarations: Number(row.declarations), invocations: Number(row.invocations),
  }, { symbols: 1, sources: 1, declarations: 1, invocations: 1 });
  assert.deepEqual(row.symbolTags, [1]);
  assert.deepEqual(row.directions, ['outgoing']);
  assert.deepEqual(row.capabilities, ['callHierarchy/outgoingCalls']);
  await handle.close();
});

test('resumes production bulk publication atomically with final run-count parity', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-persistence-resume-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const output = path.join(fixture, 'graph.lbug');
  const checkpointStore = new PipelineCheckpointStore(path.join(fixture, 'checkpoints'));
  const jar = path.resolve(
    import.meta.dirname, '../../vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar',
  );
  const lspBatch = populatedBaseLspBatch();
  const enrichmentInput = {
    lspRunId: 'run:persistence-resume', cacheDirectory: fixture, lspBatch,
    fetchSources: false,
    artifacts: [{
      buildRootId: 'root:test', providerIds: ['explicit-manifest'], scope: 'compile',
      modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
    }],
  };
  const uninterrupted = await enrichJvmArtifacts(enrichmentInput);
  let injected = false;
  class FailingConnection {
    constructor(database) { this.inner = new lbug.Connection(database); }
    async query(...args) {
      if (!injected && String(args[0]).startsWith('COPY ')) {
        injected = true;
        throw new Error('simulated COPY publication interruption');
      }
      return this.inner.query(...args);
    }
    prepare(...args) { return this.inner.prepare(...args); }
    execute(...args) { return this.inner.execute(...args); }
    close() { return this.inner.close(); }
  }
  const faultyLadybug = { Database: lbug.Database, Connection: FailingConnection };
  const normalization = { runs: [], invocations: [], relations: [] };
  await assert.rejects(persistStreamingKnowledgeGraph(
    output, 'fingerprint', checkpointStore, lspBatch, normalization,
    enrichmentInput, faultyLadybug, true,
  ), /simulated COPY publication interruption/);
  assert.equal(fs.existsSync(output), false, 'an interrupted staging database is never published');

  const resumed = await persistStreamingKnowledgeGraph(
    output, 'fingerprint', checkpointStore, lspBatch, normalization,
    enrichmentInput, lbug, true,
  );
  assert.equal(resumed.output, output);
  assert.ok(fs.existsSync(output));
  assert.equal(fs.existsSync(`${output}.partial-fingerprint.lsp-base`), false);
  assert.equal(fs.existsSync(`${output}.partial-fingerprint.artifacts`), false);
  assert.deepEqual({
    classCount: resumed.artifactEnrichment.run.classCount,
    methodCount: resumed.artifactEnrichment.run.methodCount,
    fieldCount: resumed.artifactEnrichment.run.fieldCount,
    callSiteCount: resumed.artifactEnrichment.run.callSiteCount,
    errorCount: resumed.artifactEnrichment.run.errorCount,
  }, {
    classCount: uninterrupted.runs[0].classCount,
    methodCount: uninterrupted.runs[0].methodCount,
    fieldCount: uninterrupted.runs[0].fieldCount,
    callSiteCount: uninterrupted.runs[0].callSiteCount,
    errorCount: uninterrupted.runs[0].errorCount,
  }, 'resumed run totals match an uninterrupted enrichment');
  const handle = openLspLadybugDatabase(output, lbug);
  const result = await handle.artifactRepository.connectionForBulkCopy().query(
    'MATCH (run:JvmArtifactEnrichmentRun) RETURN run.classCount AS classCount, '
      + 'run.methodCount AS methodCount, run.callSiteCount AS callSiteCount',
  );
  const [persistedRun] = await result.getAll();
  await result.close();
  assert.deepEqual({
    classCount: Number(persistedRun.classCount),
    methodCount: Number(persistedRun.methodCount),
    callSiteCount: Number(persistedRun.callSiteCount),
  }, {
    classCount: resumed.artifactEnrichment.run.classCount,
    methodCount: resumed.artifactEnrichment.run.methodCount,
    callSiteCount: resumed.artifactEnrichment.run.callSiteCount,
  });
  const baseResult = await handle.artifactRepository.connectionForBulkCopy().query(
    'MATCH (document:LspDocument)-[:LspRelation]->(symbol:LspClassSymbol) '
    + 'RETURN count(document) AS documents, count(symbol) AS symbols',
  );
  const [baseCounts] = await baseResult.getAll();
  await baseResult.close();
  assert.deepEqual(
    { documents: Number(baseCounts.documents), symbols: Number(baseCounts.symbols) },
    { documents: 1, symbols: 1 },
    'base graph is rebuilt cleanly after an interrupted COPY',
  );
  await handle.close();
});

test('resolves duplicate binary names by classpath ordinal without dropping either owner', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-duplicates-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const jars = [];
  for (const [index, method] of ['first', 'second'].entries()) {
    const source = path.join(fixture, `source-${index}/dup/Shared.java`);
    const classes = path.join(fixture, `classes-${index}`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(source, `package dup; public class Shared { public void ${method}() {} }`);
    execFileSync(jdkTool('javac'), ['-d', classes, source]);
    const jar = path.join(fixture, `${method}.jar`);
    execFileSync(jdkTool('jar'), ['cf', jar, '-C', classes, '.']);
    jars.push(jar);
  }
  const batch = await enrichJvmArtifacts({
    lspRunId: 'run:duplicates', cacheDirectory: fixture, lspBatch: emptyLspBatch(''),
    fetchSources: false,
    artifacts: jars.map((jar, index) => ({
      buildRootId: 'root:test', providerIds: ['explicit-manifest'], scope: 'compile',
      modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
      coordinate: `example:${index === 0 ? 'first' : 'second'}:1`,
    })),
  });

  const owners = batch.classes.filter((value) => value.binaryName === 'dup.Shared');
  assert.equal(owners.length, 2);
  assert.equal(batch.resolutions.filter((value) => value.binaryName === 'dup.Shared').length, 1);
  const firstArtifact = batch.artifacts.find((value) => value.classpathOrdinal === 0);
  assert.equal(batch.resolutions.find((value) => value.binaryName === 'dup.Shared').artifactId, firstArtifact.id);
  assert.ok(batch.methods.some((value) => value.name === 'first'));
  assert.ok(batch.methods.some((value) => value.name === 'second'));
});

test('isolates malformed classes and corrupt archives as structured artifact errors', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-errors-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const malformedRoot = path.join(fixture, 'malformed');
  fs.mkdirSync(malformedRoot);
  fs.writeFileSync(path.join(malformedRoot, 'Bad.class'), Buffer.from('not-a-class'));
  const malformedJar = path.join(fixture, 'malformed.jar');
  execFileSync(jdkTool('jar'), ['cf', malformedJar, '-C', malformedRoot, '.']);
  const corruptJar = path.join(fixture, 'corrupt.jar');
  fs.writeFileSync(corruptJar, Buffer.from('not-a-zip'));

  const worker = new AsmArtifactWorker(1);
  const info = await worker.start();
  const partial = await worker.analyzeArtifact({
    artifactId: 'malformed', jarPath: malformedJar, contentHash: 'a', classpathOrdinal: 0,
    runtimeMajor: info.runtimeMajor, analyzeAll: true,
  });
  assert.equal(partial.classCount, 0);
  assert.equal(partial.errorCount, 1);
  await assert.rejects(worker.analyzeArtifact({
    artifactId: 'corrupt', jarPath: corruptJar, contentHash: 'b', classpathOrdinal: 1,
    runtimeMajor: info.runtimeMajor, analyzeAll: true,
  }), /ZipException|zip END header|zip file/i);
  await worker.close();
});

test('cancels an active worker and rejects its in-flight artifact', async () => {
  const largeJar = globSync(path.join(
    import.meta.dirname, '../../vendor/jdtls/1.57.0/plugins/org.eclipse.jdt.core_*.jar',
  ), {
    absolute: true,
  })[0];
  assert.ok(largeJar);
  const worker = new AsmArtifactWorker(1);
  const info = await worker.start();
  const pending = worker.analyzeArtifact({
    artifactId: 'cancelled', jarPath: largeJar, contentHash: 'cancelled', classpathOrdinal: 0,
    runtimeMajor: info.runtimeMajor, analyzeAll: true,
  });
  worker.cancel();
  await assert.rejects(pending, /exited unexpectedly/);
  await worker.close();
});

test('restarts the persistent worker once after an unexpected exit', async (t) => {
  if (process.platform === 'win32') return t.skip('shell launcher fixture is POSIX-only');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-restart-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const fakeHome = path.join(fixture, 'jdk');
  const fakeJava = path.join(fakeHome, 'bin/java');
  const marker = path.join(fixture, 'failed-once');
  fs.mkdirSync(path.dirname(fakeJava), { recursive: true });
  fs.writeFileSync(fakeJava, [
    '#!/bin/sh',
    `if [ ! -e '${marker}' ]; then`,
    `  touch '${marker}'`,
    '  exit 17',
    'fi',
    `exec '${jdkTool('java')}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(fakeJava, 0o755);
  const previous = process.env.GITNEXUS_JDT_JAVA_HOME;
  process.env.GITNEXUS_JDT_JAVA_HOME = fakeHome;
  t.after(() => {
    if (previous === undefined) delete process.env.GITNEXUS_JDT_JAVA_HOME;
    else process.env.GITNEXUS_JDT_JAVA_HOME = previous;
  });
  const jar = path.resolve(
    import.meta.dirname, '../../vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar',
  );
  const batch = await enrichJvmArtifacts({
    lspRunId: 'run:restart', cacheDirectory: fixture, lspBatch: emptyLspBatch(''),
    maxDisassembledClasses: 1, fetchSources: false,
    artifacts: [{
      buildRootId: 'root:test', providerIds: ['explicit-manifest'], scope: 'compile',
      modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
    }],
  });
  assert.ok(fs.existsSync(marker));
  assert.equal(batch.runs[0].status, 'complete');
});

test('selects effective multi-release classes and emits deterministic bounded batches', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-protocol-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const baseSource = path.join(fixture, 'base-src/mr/Versioned.java');
  const versionSource = path.join(fixture, 'version-src/mr/Versioned.java');
  const baseClasses = path.join(fixture, 'base-classes');
  const versionClasses = path.join(fixture, 'version-classes');
  fs.mkdirSync(path.dirname(baseSource), { recursive: true });
  fs.mkdirSync(path.dirname(versionSource), { recursive: true });
  fs.writeFileSync(baseSource, 'package mr; public class Versioned { public void baseOnly() {} }');
  fs.writeFileSync(versionSource, 'package mr; public class Versioned { public void versionOnly() {} }');
  execFileSync(jdkTool('javac'), ['--release', '8', '-d', baseClasses, baseSource]);
  execFileSync(jdkTool('javac'), ['--release', '11', '-d', versionClasses, versionSource]);
  const versionedEntry = path.join(fixture, 'versioned/META-INF/versions/11/mr/Versioned.class');
  fs.mkdirSync(path.dirname(versionedEntry), { recursive: true });
  fs.copyFileSync(path.join(versionClasses, 'mr/Versioned.class'), versionedEntry);
  const manifest = path.join(fixture, 'MANIFEST.MF');
  fs.writeFileSync(manifest, 'Manifest-Version: 1.0\nMulti-Release: true\n\n');
  const jar = path.join(fixture, 'multi-release.jar');
  execFileSync(jdkTool('jar'), ['cfm', jar, manifest, '-C', baseClasses, '.']);
  execFileSync(jdkTool('jar'), ['uf', jar, '-C', path.join(fixture, 'versioned'), '.']);

  const worker = new AsmArtifactWorker(1);
  await worker.start();
  const analyze = async (artifactId, runtimeMajor) => {
    const facts = [];
    const sequences = [];
    await worker.analyzeArtifact({
      artifactId, jarPath: jar, contentHash: artifactId, classpathOrdinal: 0,
      runtimeMajor, analyzeAll: true,
    }, (batch) => { sequences.push(batch.sequence); facts.push(...batch.facts); });
    assert.deepEqual(sequences, sequences.map((_, index) => index));
    return facts;
  };
  const baseFacts = await analyze('base', 8);
  const currentFacts = await analyze('current', 21);
  assert.ok(baseFacts.some((value) => value.factType === 'method' && value.name === 'baseOnly'));
  assert.ok(!baseFacts.some((value) => value.factType === 'method' && value.name === 'versionOnly'));
  assert.ok(currentFacts.some((value) => value.factType === 'method' && value.name === 'versionOnly'));

  const manySource = path.join(fixture, 'many-src/many/Fields.java');
  const manyClasses = path.join(fixture, 'many-classes');
  fs.mkdirSync(path.dirname(manySource), { recursive: true });
  fs.writeFileSync(manySource, `package many; public class Fields {\n${
    Array.from({ length: 600 }, (_, index) => `public int field${index};`).join('\n')
  }\n}`);
  execFileSync(jdkTool('javac'), ['-d', manyClasses, manySource]);
  const manyJar = path.join(fixture, 'many.jar');
  execFileSync(jdkTool('jar'), ['cf', manyJar, '-C', manyClasses, '.']);
  const batchSizes = [];
  await worker.analyzeArtifact({
    artifactId: 'many', jarPath: manyJar, contentHash: 'many', classpathOrdinal: 0,
    runtimeMajor: 21, analyzeAll: true,
  }, async (batch) => {
    batchSizes.push(batch.facts.length);
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
  assert.ok(batchSizes.length > 1);
  assert.ok(batchSizes.every((size) => size <= 500));
  await worker.close();
});

test('replays an interrupted bounded stream idempotently into LadybugDB', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-asm-resume-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, 'src/resume/Sample.java');
  const classes = path.join(fixture, 'classes');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(classes);
  fs.writeFileSync(source, [
    'package resume;',
    'public class Sample {',
    '  public static String target() { return "ok"; }',
    '  public String call() { return target(); }',
    '}',
  ].join('\n'));
  execFileSync(jdkTool('javac'), ['-d', classes, source]);
  const jar = path.join(fixture, 'sample.jar');
  execFileSync(jdkTool('jar'), ['cf', jar, '-C', classes, '.']);
  const databasePath = path.join(fixture, 'resume.lbug');
  let handle = openLspLadybugDatabase(databasePath, lbug);
  await handle.repository.initializeSchema();
  await handle.artifactRepository.initializeSchema();
  const input = {
    lspRunId: 'run:resume', cacheDirectory: fixture, lspBatch: emptyLspBatch(''),
    fetchSources: false,
    artifacts: [{
      buildRootId: 'root:test', providerIds: ['explicit-manifest'], scope: 'compile',
      modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
    }],
  };
  let interrupted = false;
  const flaky = repositorySink(handle, async (batch) => {
    await handle.artifactRepository.mergeBatch(batch);
    if (!interrupted && batch.methods.length > 0) {
      interrupted = true;
      throw new Error('simulated interruption after committed batch');
    }
  });
  await assert.rejects(streamJvmArtifacts(input, flaky), /simulated interruption/);
  await handle.close();

  handle = openLspLadybugDatabase(databasePath, lbug);
  await streamJvmArtifacts(input, repositorySink(handle));
  const firstCounts = await artifactCounts(handle);
  await streamJvmArtifacts(input, repositorySink(handle));
  const replayCounts = await artifactCounts(handle);
  assert.deepEqual(replayCounts, firstCounts);
  assert.deepEqual(firstCounts, { classes: 1, methods: 3, callSites: 2 });
  await handle.close();
});

function emptyLspBatch(uri) {
  return {
    analysisRuns: [], servers: [], buildRoots: [], documents: [], symbols: [], callSites: [],
    occurrences: [{ uri }],
    hovers: [{ id: 'hover:test', contents: `Resolved from ${uri}` }],
    diagnostics: [], semanticTokens: [], signatureHelps: [],
    signatures: [], parameters: [], coverage: [], evidence: [], relations: [],
  };
}

function populatedBaseLspBatch() {
  return {
    analysisRuns: [{
      id: 'run:base', workspaceUri: 'file:///workspace', repositoryPath: '/workspace',
      protocolVersion: '3.18', positionEncoding: 'utf-16', status: 'complete',
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
      requestedLanguages: ['kotlin'], errorCount: 0, timeoutCount: 0,
    }],
    servers: [{
      id: 'server:base', runId: 'run:base', name: 'test', languageId: 'kotlin',
      status: 'ready', capabilitiesJson: '{}', buildRootId: 'root:base',
    }],
    buildRoots: [{
      id: 'root:base', runId: 'run:base', workspaceUri: 'file:///workspace', repositoryPath: '/workspace',
      relativePath: '.', buildSystems: ['gradle'], javaMajor: 21, importStatus: 'ready', excludedRootIds: [],
    }],
    documents: [{
      id: 'document:base', uri: 'file:///workspace/Base.kt', filePath: '/workspace/Base.kt',
      languageId: 'kotlin', contentHash: 'hash', origin: 'repository', wasOpened: true,
      buildRootId: 'root:base',
    }],
    symbols: [{
      id: 'symbol:base', documentId: 'document:base', uri: 'file:///workspace/Base.kt', name: 'Base',
      kind: 5, kindName: 'Class', tags: [1], range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      stableKey: 'Base', isExternal: false,
    }],
    callSites: [], occurrences: [], hovers: [], diagnostics: [], semanticTokens: [], signatureHelps: [],
    signatures: [], parameters: [], coverage: [], evidence: [],
    relations: [{
      id: 'lsp:defines', sourceKind: 'LspDocument', sourceId: 'document:base',
      targetKind: 'LspClassSymbol', targetId: 'symbol:base', kind: 'DEFINES', runId: 'run:base',
      serverId: 'server:base', capability: 'textDocument/documentSymbol', status: 'resolved',
      providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal: 0,
    }],
  };
}

class RecordingConnection {
  queries = [];
  async query(cypher) { this.queries.push(cypher); return { close() {} }; }
  async prepare() { return { isSuccess: () => true }; }
  async execute() { return { close() {} }; }
}

function jdkTool(name) {
  const home = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
  if (home) return path.join(home, 'bin', name);
  return [
    ...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(path.join(os.homedir(), `.local/jdks/*/bin/${name}`)),
  ][0] ?? name;
}

function repositorySink(handle, writeOverride) {
  return {
    initialize: async (_run, batch) => handle.artifactRepository.mergeBatch(batch),
    write: writeOverride ?? ((batch) => handle.artifactRepository.mergeBatch(batch)),
    completeArtifact: async (artifact) => handle.artifactRepository.mergeBatch({
      runs: [], artifacts: [artifact], resolutions: [], binaryReferences: [], binaryReferenceRelations: [],
      classes: [], methods: [], fields: [],
      callSites: [], relations: [], bindings: [],
    }),
    resolveClassArtifacts: (names) => handle.artifactRepository.resolveClassArtifacts(names),
    finalize: async (run) => {
      await handle.artifactRepository.finalizeAsmRelations(run.id);
      await handle.artifactRepository.finalizeAsmRun(run);
    },
  };
}

async function artifactCounts(handle) {
  const count = async (table) => {
    const result = await handle.artifactRepository.connection.query(
      `MATCH (n:${table}) RETURN count(n) AS count`,
    );
    const rows = await result.getAll();
    await result.close();
    return Number(rows[0].count);
  };
  return {
    classes: await count('JvmClass'), methods: await count('JvmMethod'),
    callSites: await count('JvmCallSite'),
  };
}
