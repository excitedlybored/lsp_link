import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { globSync } from 'glob';

import {
  AsmProgramAnalyzer,
  ComparisonProgramAnalyzer,
  SootUpProgramAnalyzer,
} from '../dist/artifact/program-analyzer.js';
import { streamJvmArtifacts } from '../dist/artifact/streaming-enrichment.js';

const SAMPLE = path.resolve(import.meta.dirname, '../../sample_projects/sootup-temporal-kafka-flow');

test('SootUp preserves the representative first-party semantic facts without retaining bodies', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sootup-comparison-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const classes = path.join(fixture, 'classes');
  fs.mkdirSync(classes);
  const sources = globSync(path.join(SAMPLE, 'src/main/java/**/*.java')).sort();
  execFileSync(jdkTool('javac'), ['-g', '-parameters', '-d', classes, ...sources]);
  const jar = path.join(fixture, 'neutral-flow.jar');
  execFileSync(jdkTool('jar'), ['cf', jar, '-C', classes, '.']);
  const request = {
    artifactId: 'fixture', jarPath: jar, contentHash: 'fixture', classpathOrdinal: 0,
    runtimeMajor: 21, analyzeAll: true, emitClassFacts: true, emitCalls: true,
    classpathEntries: [jar],
  };

  const comparison = new ComparisonProgramAnalyzer(new AsmProgramAnalyzer(1), new SootUpProgramAnalyzer(1));
  await comparison.start();
  t.after(() => comparison.close());
  const compared = await comparison.analyzeArtifact(request);
  const asm = compared.baseline.flatMap((batch) => batch.facts);
  const sootup = compared.candidate.flatMap((batch) => batch.facts);

  const missingClasses = classNames(asm).filter((name) => !classNames(sootup).includes(name));
  assert.deepEqual(missingClasses, [
    'io.temporal.activity.ActivityInterface',
    'io.temporal.workflow.WorkflowInterface',
    'io.temporal.workflow.WorkflowMethod',
    'org.springframework.kafka.annotation.KafkaListener',
  ], 'SootUp 2.0 omits annotation declarations; their usages remain authoritative evidence');
  assert.deepEqual(
    methodSignatures(sootup),
    methodSignatures(asm).filter((signature) => !missingClasses.some((name) => signature.startsWith(`${name}#`))),
  );
  assert.ok(sootup.some((fact) => fact.factType === 'class'
    && fact.binaryName === 'example.NeutralWorkflow'
    && fact.annotations.includes('io.temporal.workflow.WorkflowInterface')));
  assert.ok(sootup.some((fact) => fact.factType === 'method'
    && fact.owner === 'example.TopicListener'
    && fact.annotations.includes('org.springframework.kafka.annotation.KafkaListener')));
  for (const expected of [
    'io.temporal.client.WorkflowClient#start',
    'example.PublishingActivity#publish',
    'org.springframework.kafka.core.KafkaTemplate#send',
  ]) assert.ok(callTargets(sootup).has(expected), expected);
  assert.ok(compared.candidate.every((batch) => batch.facts.length <= 500));

  const headerOnly = new SootUpProgramAnalyzer(1);
  await headerOnly.start();
  t.after(() => headerOnly.close());
  const projected = [];
  await headerOnly.analyzeArtifact({ ...request, emitCalls: false }, (batch) => projected.push(...batch.facts));
  assert.equal(projected.some((fact) => fact.factType === 'call'), false);
});

test('compact SootUp normalization keeps calls and annotations but creates no call-site nodes', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sootup-compact-stream-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const classes = path.join(fixture, 'classes');
  fs.mkdirSync(classes);
  const sources = globSync(path.join(SAMPLE, 'src/main/java/**/*.java')).sort();
  execFileSync(jdkTool('javac'), ['-g', '-parameters', '-d', classes, ...sources]);
  const jar = path.join(fixture, 'neutral-flow.jar');
  execFileSync(jdkTool('jar'), ['cf', jar, '-C', classes, '.']);
  const collected = emptyJvmBatch();
  const input = {
    lspRunId: 'run:fixture', artifacts: [{
      buildRootId: 'bazel:.', providerIds: ['fixture'], scope: 'compile', modulePath: false,
      classpathEntryPath: jar, binaryJarPath: jar, codeOrigin: 'first_party_artifact',
    }], cacheDirectory: fixture, lspBatch: emptyLspBatch(), analyzer: 'sootup', projection: 'compact',
    externalBodies: 'none', workerConcurrency: 1, fetchSources: false,
  };
  const summary = await streamJvmArtifacts(input, collectingSink(collected));

  assert.equal(summary.run.provider, 'sootup');
  assert.equal(summary.run.graphSchemaVersion, 2);
  assert.equal(summary.run.projection, 'compact');
  assert.equal(collected.callSites.length, 0);
  assert.ok(collected.compactCalls.some((call) => call.targetSignature.includes('KafkaTemplate#send')));
  assert.ok(collected.methods.some((method) => method.owner === 'example.TopicListener'
    && method.annotations.includes('org.springframework.kafka.annotation.KafkaListener')
    && method.annotationValuesJson.includes('messaging.topic')));
  assert.equal(new Set(collected.classes.map((value) => value.id)).size, collected.classes.length);
  assert.equal(summary.run.callSiteCount, collected.compactCalls.length);

  const legacy = emptyJvmBatch();
  await streamJvmArtifacts({ ...input, analyzer: 'asm', projection: 'legacy', externalBodies: 'all' },
    collectingSink(legacy));
  const sootClassIds = new Map(collected.classes.map((value) => [value.binaryName, value.id]));
  for (const value of legacy.classes) {
    if (sootClassIds.has(value.binaryName)) assert.equal(sootClassIds.get(value.binaryName), value.id);
  }
  const sootMethodIds = new Map(collected.methods.map((value) => [
    `${value.owner}#${value.name}${value.descriptor}`, value.id,
  ]));
  for (const value of legacy.methods) {
    const key = `${value.owner}#${value.name}${value.descriptor}`;
    if (sootMethodIds.has(key)) assert.equal(sootMethodIds.get(key), value.id);
  }

  const cacheFiles = globSync(path.join(fixture, 'program-facts/sootup/*.ndjson')).sort();
  assert.ok(cacheFiles.length > 0);
  const mtimes = cacheFiles.map((file) => fs.statSync(file).mtimeMs);
  const warm = emptyJvmBatch();
  await streamJvmArtifacts(input, collectingSink(warm));
  assert.deepEqual(cacheFiles.map((file) => fs.statSync(file).mtimeMs), mtimes,
    'an unchanged warm run replays immutable artifact facts without rewriting them');
  assert.deepEqual(callTargetsFromCompact(warm), callTargetsFromCompact(collected));

  fs.appendFileSync(cacheFiles[0], '{corrupt\n');
  await streamJvmArtifacts(input, collectingSink(emptyJvmBatch()));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cacheFiles[0], 'utf8').trim().split(/\r?\n/).at(-1)));

  const marker = path.join(fixture, 'projection-policy.txt');
  fs.writeFileSync(marker, 'changed artifact content');
  execFileSync(jdkTool('jar'), ['uf', jar, '-C', fixture, path.basename(marker)]);
  await streamJvmArtifacts(input, collectingSink(emptyJvmBatch()));
  assert.ok(globSync(path.join(fixture, 'program-facts/sootup/*.ndjson')).length > cacheFiles.length,
    'an artifact content change creates a distinct fact-cache entry');
});

test('compact ASM applies the same provider-neutral boundary projection', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-compact-stream-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const classes = path.join(fixture, 'classes');
  fs.mkdirSync(classes);
  const sources = globSync(path.join(SAMPLE, 'src/main/java/**/*.java')).sort();
  execFileSync(jdkTool('javac'), ['-g', '-parameters', '-d', classes, ...sources]);
  const jar = path.join(fixture, 'neutral-flow.jar');
  execFileSync(jdkTool('jar'), ['cf', jar, '-C', classes, '.']);
  const collected = emptyJvmBatch();
  const summary = await streamJvmArtifacts({
    lspRunId: 'run:asm-compact', artifacts: [{
      buildRootId: 'bazel:.', providerIds: ['fixture'], scope: 'compile', modulePath: false,
      classpathEntryPath: jar, binaryJarPath: jar, codeOrigin: 'first_party_artifact',
    }], cacheDirectory: fixture, lspBatch: emptyLspBatch(), analyzer: 'asm', projection: 'compact',
    externalBodies: 'none', workerConcurrency: 1, fetchSources: false,
  }, collectingSink(collected));

  assert.equal(summary.run.provider, 'asm');
  assert.equal(summary.run.graphSchemaVersion, 2);
  assert.equal(collected.callSites.length, 0);
  assert.ok(collected.compactCalls.some((call) =>
    call.targetSignature.includes('KafkaTemplate#send')
      && call.evidence === 'ASM bytecode invocation'));
  assert.ok(collected.methods.some((method) => method.owner === 'example.TopicListener'
    && method.annotations.includes('org.springframework.kafka.annotation.KafkaListener')
    && method.annotationValuesJson.includes('messaging.topic')
    && method.annotationValuesJson.includes('neutral-workers')));
});

test('compact projection retains referenced external signatures and omits unrelated implementations', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sootup-external-projection-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const dependencySource = path.join(fixture, 'dependency-src/external');
  const applicationSource = path.join(fixture, 'application-src/example');
  const dependencyClasses = path.join(fixture, 'dependency-classes');
  const applicationClasses = path.join(fixture, 'application-classes');
  fs.mkdirSync(dependencySource, { recursive: true });
  fs.mkdirSync(applicationSource, { recursive: true });
  fs.mkdirSync(dependencyClasses);
  fs.mkdirSync(applicationClasses);
  fs.writeFileSync(path.join(dependencySource, 'UsedApi.java'),
    'package external; public class UsedApi { public void invoke(String value) {} }');
  fs.writeFileSync(path.join(dependencySource, 'UnrelatedImplementation.java'),
    'package external; public class UnrelatedImplementation { public void hidden() {} }');
  fs.writeFileSync(path.join(applicationSource, 'EntryPoint.java'),
    'package example; public class EntryPoint { public void run(external.UsedApi api) { api.invoke("x"); } }');
  execFileSync(jdkTool('javac'), ['-d', dependencyClasses,
    path.join(dependencySource, 'UsedApi.java'), path.join(dependencySource, 'UnrelatedImplementation.java')]);
  const dependencyJar = path.join(fixture, 'dependency.jar');
  execFileSync(jdkTool('jar'), ['cf', dependencyJar, '-C', dependencyClasses, '.']);
  execFileSync(jdkTool('javac'), ['-cp', dependencyJar, '-d', applicationClasses,
    path.join(applicationSource, 'EntryPoint.java')]);
  const applicationJar = path.join(fixture, 'application.jar');
  execFileSync(jdkTool('jar'), ['cf', applicationJar, '-C', applicationClasses, '.']);

  const collected = emptyJvmBatch();
  await streamJvmArtifacts({
    lspRunId: 'run:external-projection',
    artifacts: [
      { buildRootId: 'bazel:.', providerIds: ['application'], scope: 'compile', modulePath: false,
        classpathEntryPath: applicationJar, binaryJarPath: applicationJar,
        codeOrigin: 'first_party_artifact' },
      { buildRootId: 'bazel:.', providerIds: ['dependency'], scope: 'compile', modulePath: false,
        classpathEntryPath: dependencyJar, binaryJarPath: dependencyJar,
        codeOrigin: 'external_dependency' },
    ],
    cacheDirectory: fixture, lspBatch: emptyLspBatch(), analyzer: 'sootup', projection: 'compact',
    externalBodies: 'none', workerConcurrency: 1, fetchSources: false,
  }, collectingSink(collected));

  assert.ok(collected.classes.some((value) => value.binaryName === 'external.UsedApi'));
  assert.ok(collected.methods.some((value) => value.owner === 'external.UsedApi'
    && value.name === 'invoke'));
  assert.equal(collected.classes.some(
    (value) => value.binaryName === 'external.UnrelatedImplementation'), false);
  assert.equal(collected.methods.some(
    (value) => value.owner === 'external.UnrelatedImplementation'), false);
  assert.ok(collected.compactCalls.some(
    (value) => value.targetSignature.startsWith('external.UsedApi#invoke')));
  assert.equal(collected.typeReferences.filter(
    (value) => value.binaryName === 'external.UsedApi').at(-1)?.status, 'resolved');

  const asm = emptyJvmBatch();
  await streamJvmArtifacts({
    lspRunId: 'run:external-projection-asm',
    artifacts: [
      { buildRootId: 'bazel:.', providerIds: ['application'], scope: 'compile', modulePath: false,
        classpathEntryPath: applicationJar, binaryJarPath: applicationJar,
        codeOrigin: 'first_party_artifact' },
      { buildRootId: 'bazel:.', providerIds: ['dependency'], scope: 'compile', modulePath: false,
        classpathEntryPath: dependencyJar, binaryJarPath: dependencyJar,
        codeOrigin: 'external_dependency' },
    ],
    cacheDirectory: fixture, lspBatch: emptyLspBatch(), analyzer: 'asm', projection: 'compact',
    externalBodies: 'none', workerConcurrency: 1, fetchSources: false,
  }, collectingSink(asm));
  assert.ok(asm.classes.some((value) => value.binaryName === 'external.UsedApi'));
  assert.ok(asm.methods.some((value) => value.owner === 'external.UsedApi'
    && value.name === 'invoke'));
  assert.equal(asm.classes.some(
    (value) => value.binaryName === 'external.UnrelatedImplementation'), false);
  assert.equal(asm.methods.some(
    (value) => value.owner === 'external.UnrelatedImplementation'), false);
  assert.ok(asm.compactCalls.some(
    (value) => value.targetSignature.startsWith('external.UsedApi#invoke')));
});

function classNames(facts) {
  return [...facts.filter((fact) => fact.factType === 'class').map((fact) => fact.binaryName)].sort();
}

function methodSignatures(facts) {
  return [...facts.filter((fact) => fact.factType === 'method')
    .map((fact) => `${fact.owner}#${fact.name}${fact.descriptor}`)].sort();
}

function callTargets(facts) {
  return new Set(facts.filter((fact) => fact.factType === 'call')
    .map((fact) => `${fact.targetOwner}#${fact.targetName}`));
}

function jdkTool(name) {
  const home = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
  if (home) return path.join(home, 'bin', name);
  return [...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(path.join(os.homedir(), `.local/jdks/*/bin/${name}`))][0] ?? name;
}

function emptyJvmBatch() {
  return { runs: [], artifacts: [], resolutions: [], binaryReferences: [], binaryReferenceRelations: [],
    classes: [], methods: [], fields: [], callSites: [], methodReferences: [], compactCalls: [],
    typeReferences: [], compactTypeReferences: [], relations: [], bindings: [] };
}

function merge(target, source) {
  for (const key of Object.keys(target)) target[key].push(...(source[key] ?? []));
}

function emptyLspBatch() {
  return { analysisRuns: [{ id: 'run:fixture' }], buildRoots: [], servers: [], documents: [], symbols: [],
    callSites: [], occurrences: [], hovers: [], diagnostics: [], semanticTokens: [], signatureHelps: [],
    signatures: [], parameters: [], coverage: [], evidence: [], relations: [] };
}

function collectingSink(target) {
  const resolutions = new Map();
  return {
    async initialize(_run, batch) { merge(target, batch); },
    async write(batch) {
      merge(target, batch);
      for (const value of batch.resolutions) resolutions.set(value.binaryName, value.artifactId);
    },
    async completeArtifact() {},
    async resolveClassArtifacts(names) {
      return new Map(names.flatMap((name) => resolutions.has(name) ? [[name, resolutions.get(name)]] : []));
    },
    async finalize() {},
  };
}

function callTargetsFromCompact(batch) {
  return batch.compactCalls.map((call) => call.targetSignature).sort();
}
