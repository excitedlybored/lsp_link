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
