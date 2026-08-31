import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ArtifactClasspathResolver,
  BazelJavaInfoClasspathProvider,
  ExplicitClasspathManifestProvider,
  GradleBuildshipClasspathProvider,
  JdtLsClasspathProvider,
  MavenM2eClasspathProvider,
  inferMavenCoordinate,
  retainArtifactClasspathEntries,
} from '../dist/artifact/classpath/index.js';

test('retains normalized JARs outside ephemeral build output', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-provider-retain-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const outputJar = path.join(fixture, 'bazel-out/demo.jar');
  fs.mkdirSync(path.dirname(outputJar), { recursive: true });
  fs.writeFileSync(outputJar, 'binary');
  const retained = retainArtifactClasspathEntries([{
    buildRootId: 'root:test', providerIds: ['bazel-java-info'], scope: 'runtime',
    modulePath: false, classpathEntryPath: outputJar, binaryJarPath: outputJar,
  }], path.join(fixture, 'retained'));
  fs.rmSync(path.dirname(outputJar), { recursive: true, force: true });
  assert.ok(fs.existsSync(retained[0].classpathEntryPath));
  assert.equal(retained[0].classpathEntryPath, retained[0].binaryJarPath);
  assert.deepEqual(retained[0].classpathEntryAliases, ['demo.jar']);
});

test('Bazel JavaInfo maps compile header JARs to authoritative runtime JARs', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-provider-bazel-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const header = path.join(fixture, 'compile/header_demo.jar');
  const binary = path.join(fixture, 'runtime/demo.jar');
  fs.mkdirSync(path.dirname(header), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(header, 'header');
  fs.writeFileSync(binary, 'binary');
  const modelPath = path.join(fixture, 'bazel-project.json');
  fs.writeFileSync(modelPath, JSON.stringify({ classpath: [header], runtimeClasspath: [binary] }));
  const descriptors = await new BazelJavaInfoClasspathProvider().resolveArtifacts({
    root: { id: 'root:bazel', workspacePath: fixture, systems: ['bazel'] },
    documentUris: [], bazelModelPath: modelPath,
    loadJdtRuntimeClasspath: async () => [],
  });
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].headerJarPath, header);
  assert.equal(descriptors[0].binaryJarPath, binary);
  assert.deepEqual(descriptors[0].providerIds, ['bazel-java-info']);
});

test('only the selected native importer claims the JDT effective classpath', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-provider-jdt-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const mavenJar = path.join(fixture, '.m2/repository/com/acme/demo/1.2/demo-1.2.jar');
  const moduleJar = path.join(fixture, '.gradle/caches/modules-2/files-2.1/org.example/mod/2.0/hash/mod-2.0.jar');
  fs.mkdirSync(path.dirname(mavenJar), { recursive: true });
  fs.mkdirSync(path.dirname(moduleJar), { recursive: true });
  fs.writeFileSync(mavenJar, 'jar');
  fs.writeFileSync(moduleJar, 'jar');
  const calls = [];
  const adapter = {
    async request(method, params) {
      calls.push({ method, params });
      if (params.command === 'java.project.getAll') return ['file:///workspace/project'];
      return { projectRoot: 'file:///workspace/project', classpaths: [mavenJar], modulepaths: [moduleJar] };
    },
  };
  const context = {
    root: { id: 'root:mixed', workspacePath: fixture, systems: ['maven', 'gradle'] },
    nativeImporter: 'maven',
    lspClient: adapter, documentUris: ['file:///workspace/project/src/Main.java'],
  };
  const resolver = new ArtifactClasspathResolver([
    new MavenM2eClasspathProvider(), new GradleBuildshipClasspathProvider(),
  ]);
  const resolution = await resolver.resolveArtifacts(context);
  const descriptors = resolution.artifacts;

  assert.equal(calls.filter((value) => value.params.command === 'java.project.getAll').length, 1);
  assert.equal(calls.filter((value) => value.params.command === 'java.project.getClasspaths').length, 1);
  assert.equal(descriptors.length, 2);
  assert.deepEqual(resolution.attempts.map((value) => [value.providerId, value.status]), [['maven-m2e', 'resolved']]);
  assert.deepEqual(descriptors[0].providerIds, ['maven-m2e']);
  assert.deepEqual(descriptors[1].providerIds, ['maven-m2e']);
  assert.equal(descriptors.find((value) => value.classpathEntryPath === moduleJar).modulePath, true);
  assert.equal(inferMavenCoordinate(mavenJar), 'com.acme:demo:1.2');
  assert.equal(inferMavenCoordinate(moduleJar), 'org.example:mod:2.0');
});

test('generic JDT provider falls back to a representative document URI', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-provider-generic-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const jar = path.join(fixture, 'lib.jar');
  fs.writeFileSync(jar, 'jar');
  const calls = [];
  const context = {
    root: { id: 'root:jdt', workspacePath: fixture, systems: [] },
    documentUris: ['file:///workspace/Main.java'],
    lspClient: {
      async request(_method, params) {
        calls.push(params);
        if (params.command === 'java.project.getAll') throw new Error('not supported');
        return { classpaths: [jar], modulepaths: [] };
      },
    },
  };
  const resolution = await new ArtifactClasspathResolver([
    new JdtLsClasspathProvider(),
  ]).resolveArtifacts(context);
  const descriptors = resolution.artifacts;
  assert.equal(descriptors.length, 1);
  assert.deepEqual(descriptors[0].providerIds, ['jdt-ls']);
  assert.deepEqual(calls[1].arguments, ['file:///workspace/Main.java', '{"scope":"runtime"}']);
});

test('explicit manifests normalize relative artifact metadata', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-provider-manifest-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const name of ['header_demo.jar', 'demo.jar', 'demo-sources.jar']) fs.writeFileSync(path.join(fixture, name), 'jar');
  const manifest = path.join(fixture, 'artifacts.json');
  fs.writeFileSync(manifest, JSON.stringify({ artifacts: [{
    classpathEntryPath: 'header_demo.jar', headerJarPath: 'header_demo.jar',
    binaryJarPath: 'demo.jar', sourceJarPath: 'demo-sources.jar',
    coordinate: 'example:demo:1', scope: 'test', modulePath: true,
  }] }));
  const descriptors = await new ExplicitClasspathManifestProvider().resolveArtifacts({
    root: { id: 'root:manifest', workspacePath: fixture, systems: [] },
    documentUris: [], manifestPaths: [manifest],
    loadJdtRuntimeClasspath: async () => [],
  });
  assert.deepEqual(descriptors, [{
    buildRootId: 'root:manifest', providerIds: ['explicit-manifest'], scope: 'test', modulePath: true,
    classpathEntryPath: path.join(fixture, 'header_demo.jar'),
    headerJarPath: path.join(fixture, 'header_demo.jar'),
    binaryJarPath: path.join(fixture, 'demo.jar'),
    sourceJarPath: path.join(fixture, 'demo-sources.jar'), coordinate: 'example:demo:1',
  }]);
});
