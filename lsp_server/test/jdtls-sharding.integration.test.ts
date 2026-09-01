import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planJdtlsBuildRootShards, prepareJdtlsShardWorkspace } from '../adapters/java/jdtls-sharding.js';
import { JdtlsRuntimeLocator, type JavaBuildRoot } from '../adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';

test('one persistent JDT LS process preserves project isolation and root-local resolution', {
  skip: process.env.GITNEXUS_RUN_JDTLS_INTEGRATION !== '1',
  timeout: 180_000,
}, async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-shard-live-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const dependencyJar = JdtlsRuntimeLocator.locate().equinoxLauncherJar;
  const roots: JavaBuildRoot[] = [1, 2].map((number) => {
    const workspacePath = path.join(repository, `root-${number}`);
    const source = path.join(workspacePath, 'src/main/java');
    fs.mkdirSync(path.join(source, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(source, `app${number}`), { recursive: true });
    fs.writeFileSync(path.join(source, 'shared/Helper.java'), [
      'package shared;',
      `public class Helper { public String root() { return "root-${number}"; } }`,
    ].join('\n'));
    fs.writeFileSync(path.join(source, `app${number}/App.java`), [
      `package app${number};`,
      'import shared.Helper;',
      `public class App { public String run() { return new Helper().root(); } }`,
    ].join('\n'));
    const modelDirectory = path.join(workspacePath, '.gitnexus/jdtls');
    fs.mkdirSync(modelDirectory, { recursive: true });
    fs.writeFileSync(path.join(modelDirectory, 'bazel-project.json'), JSON.stringify({
      classpath: [dependencyJar],
      runtimeClasspath: [dependencyJar],
      sourcePaths: ['src/main/java'],
      generatedSourcePaths: [],
      configurationHash: `live-root-${number}`,
    }));
    return {
      // A bazel-prefixed id catches accidental collisions with JDT's default
      // `bazel-.*` resource filter in generated Eclipse project names.
      id: `bazel:root-${number}`,
      workspacePath,
      relativePath: `root-${number}`,
      systems: ['bazel'] as const,
      excludedRoots: [],
    };
  });
  const shard = prepareJdtlsShardWorkspace(repository, planJdtlsBuildRootShards(roots, 1)[0]);
  const registry = new LspAdapterRegistry();
  const adapter = await registry.getOrStartJavaShard(shard);
  assert.ok(adapter, 'JDT LS must start');
  t.after(() => registry.shutdownAll());

  for (const [index, root] of roots.entries()) {
    const number = index + 1;
    const app = path.join(root.workspacePath, `src/main/java/app${number}/App.java`);
    const classpath = await adapter.request<{ projectRoot?: string; classpaths?: string[] }>('workspace/executeCommand', {
      command: 'java.project.getClasspaths',
      arguments: [adapter.documentUri(app), JSON.stringify({ scope: 'runtime' })],
    });
    const expectedProject = shard.projectModels.find((model) => model.buildRootId === root.id);
    assert.ok(expectedProject);
    assert.equal(
      fileURLToPath(classpath.projectRoot!),
      path.join(shard.workspacePath, 'projects', expectedProject.projectName),
      `root-${number} document must belong to its generated Eclipse project`,
    );
    assert.ok(
      classpath.classpaths?.some((entry) => path.resolve(entry) === path.resolve(dependencyJar)),
      `root-${number} effective classpath must retain the generated Bazel dependency`,
    );
    const symbols = await adapter.documentSymbols(app);
    assert.ok(symbols.some((symbol) => symbol.name === 'App'));
    const definitions = await adapter.findDefinition(app, 2, 55);
    assert.ok(definitions.length > 0, `root-${number} Helper must resolve`);
    const expected = pathToFileURL(path.join(root.workspacePath, 'src/main/java/shared/Helper.java')).href;
    assert.equal(definitions[0].uri.toLowerCase(), expected.toLowerCase());
  }
  assert.equal(adapter.getSessionMetadata().processShardId, shard.id);
  assert.deepEqual(adapter.getSessionMetadata().buildRootIds, roots.map((root) => root.id));
});

test('imports an enterprise-scale Bazel classpath into one generated Eclipse project', {
  skip: process.env.GITNEXUS_RUN_JDTLS_INTEGRATION !== '1',
  timeout: 300_000,
}, async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-large-classpath-live-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const sourceRoot = path.join(repository, 'src/main/java/example');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const sources = Array.from({ length: 129 }, (_, index) => {
    const source = path.join(sourceRoot, `Application${index}.java`);
    const content = `package example; public class Application${index} {}\n`;
    fs.writeFileSync(source, content);
    return {
      path: source, analysisPath: source, origin: 'repository' as const,
      contentHash: createHash('sha256').update(content).digest('hex'),
      targetLabels: ['//:application'], originalRepositoryPaths: [source],
      configuredSourceAssociations: [], sourceJarAssociations: [],
    };
  });
  const source = sources[0].path;

  const dependencyJar = JdtlsRuntimeLocator.locate().equinoxLauncherJar;
  const libraryRoot = path.join(repository, '.gitnexus/test-classpath');
  fs.mkdirSync(libraryRoot, { recursive: true });
  const artifacts = Array.from({ length: 1_678 }, (_, index) => {
    const identity = `dependency-${index.toString().padStart(4, '0')}`;
    const compile = path.join(libraryRoot, `${identity}-ijar.jar`);
    const runtime = path.join(libraryRoot, `${identity}.jar`);
    // JDT may reject compiler-only interface archives even though Bazel can
    // consume them. The runtime counterpart must be selected before import.
    fs.writeFileSync(compile, 'interface-only');
    fs.copyFileSync(dependencyJar, runtime, fs.constants.COPYFILE_FICLONE);
    return { compile, runtime };
  });
  const classpath = artifacts.map((artifact) => artifact.compile);
  const runtimeClasspath = artifacts.map((artifact) => artifact.runtime);
  const modelDirectory = path.join(repository, '.gitnexus/jdtls');
  fs.mkdirSync(modelDirectory, { recursive: true });
  const sourceInventoryPath = path.join(modelDirectory, 'bazel-source-inventory.json');
  fs.writeFileSync(sourceInventoryPath, JSON.stringify({
    schemaVersion: 3,
    workspacePath: repository,
    configurationHash: 'live-large-classpath',
    targetQuery: '//...',
    generatedAt: new Date().toISOString(),
    targets: [],
    sources,
    comparison: {
      repositorySources: sources.length,
      configuredRepositorySources: sources.length,
      generatedSources: 0,
      sourceJarOnlySources: 0,
      externalTargetsRetained: 0,
      externalSourceJarAssociationsExcluded: 0,
      unownedRepositorySources: [],
      duplicateSources: 0,
      crawlSources: sources.length,
    },
  }));
  fs.writeFileSync(path.join(modelDirectory, 'bazel-project.json'), JSON.stringify({
    classpath,
    runtimeClasspath,
    sourcePaths: ['src/main/java'],
    generatedSourcePaths: [],
    configurationHash: 'live-large-classpath',
    sourceInventoryPath,
  }));
  const root: JavaBuildRoot = {
    id: 'bazel:.', workspacePath: repository, relativePath: '.', systems: ['bazel'], excludedRoots: [],
  };
  const shard = prepareJdtlsShardWorkspace(repository, planJdtlsBuildRootShards([root], 1)[0]);
  const registry = new LspAdapterRegistry();
  t.after(() => registry.shutdownAll());
  const adapter = await registry.getOrStartJavaShard(shard);
  assert.ok(adapter, 'JDT LS must retain the enterprise-scale generated classpath');
  const response = await adapter.request<{ classpaths?: string[] }>('workspace/executeCommand', {
    command: 'java.project.getClasspaths',
    arguments: [adapter.documentUri(source), JSON.stringify({ scope: 'runtime' })],
  });
  const actual = new Set((response.classpaths ?? []).map((entry) => path.resolve(entry)));
  assert.equal(runtimeClasspath.filter((entry) => actual.has(path.resolve(entry))).length, runtimeClasspath.length);
  assert.equal(classpath.filter((entry) => actual.has(path.resolve(entry))).length, 0);
});

test('Spring Tools receives JDT classpaths and reports framework structure', {
  skip: process.env.GITNEXUS_RUN_JDTLS_INTEGRATION !== '1',
  timeout: 180_000,
}, async (t) => {
  const repository = path.resolve(import.meta.dirname, '../../sample_projects/gs-rest-service');
  const registry = new LspAdapterRegistry();
  const root = registry.getJavaBuildRoots(repository)
    .find((candidate) => candidate.relativePath === 'complete');
  assert.ok(root, 'Spring sample complete root must be discovered');
  const shard = prepareJdtlsShardWorkspace(repository, planJdtlsBuildRootShards([root], 1)[0]);
  t.after(async () => {
    await registry.shutdownAll();
    fs.rmSync(shard.workspacePath, { recursive: true, force: true });
  });
  const java = await registry.getOrStartJavaShard(shard);
  assert.ok(java, 'JDT LS must start for the Spring sample');
  const spring = registry.getJavaCompanion(java, root.id);
  assert.ok(spring, 'Spring Tools companion must start for the Spring build root');
  const projects = await spring.request<unknown[]>('workspace/executeCommand', {
    command: 'sts/spring-boot/executableBootProjects', arguments: [],
  });
  const structure = await spring.request<unknown[]>('workspace/executeCommand', {
    command: 'sts/spring-boot/structure', arguments: [{ updateMetadata: true }],
  });
  assert.ok(projects.length > 0, 'Spring Tools must receive at least one executable project');
  assert.match(JSON.stringify(structure), /Controllers \(Spring Web\)/);
  assert.match(JSON.stringify(structure), /\/greeting -- GET/);
});
