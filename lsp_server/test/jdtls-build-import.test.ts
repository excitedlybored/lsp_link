import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createJdtlsProcessLaunch,
  discoverJavaBuildRoots,
  JdtlsRuntime,
  JdtlsWorkspace,
  jdtlsResolutionClasspath,
  ownerBuildRoot,
} from '../adapters/java/jdtls-runtime.js';
import { ensureBazelProjectModel, prepareBazelProjectModels } from '../adapters/java/bazel-project-model.js';
import { planJdtlsBuildRootShards, prepareJdtlsShardWorkspace } from '../adapters/java/jdtls-sharding.js';

const runtime: JdtlsRuntime = {
  jdkJavaBin: '/jdk/25/bin/java',
  jdkMajorVersion: 25,
  equinoxLauncherJar: '/jdtls/launcher.jar',
  osgiConfigDir: '/jdtls/config',
};

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-build-import-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return root;
}

function javaSettings(root: string): any {
  const workspace = JdtlsWorkspace.inspect(root);
  const launch = createJdtlsProcessLaunch(root, workspace, runtime, path.join(root, '.jdtls-test'));
  return { workspace, java: (launch.initializationOptions as any).settings.java };
}

test('detects and configures a Gradle workspace independently', () => {
  const root = fixture({
    'settings.gradle.kts': 'rootProject.name = "sample"',
    'gradle.properties': [
      'sourceCompatibility=25',
      'org.gradle.unsafe.isolated-projects=true',
    ].join('\n'),
    'src/main/java/Sample.java': 'class Sample {}',
  });
  const { workspace, java } = javaSettings(root);
  assert.deepEqual(workspace.buildSystems.map((system) => system.kind), ['gradle']);
  assert.equal(workspace.requiredJavaMajor, 25);
  assert.equal(java.import.gradle.enabled, true);
  assert.equal(java.import.maven.enabled, false);
  assert.match(java.import.gradle.arguments, /isolated-projects=false/);
});

test('detects Maven modules and their declared Java release', () => {
  const root = fixture({
    'pom.xml': '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>',
    'module/pom.xml': '<project/>',
    'module/src/main/java/Sample.java': 'class Sample {}',
  });
  const { workspace, java } = javaSettings(root);
  assert.equal(workspace.usesMaven, true);
  assert.equal(workspace.requiredJavaMajor, 21);
  assert.equal(workspace.buildSystems[0].roots.length, 1);
  assert.equal(java.import.maven.enabled, true);
  assert.equal(java.import.gradle.enabled, false);
});

test('loads an exact Bazel project model instead of guessing bazel-bin jars', () => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "sample")',
    '.bazelrc': 'build --java_language_version=25',
    '.gitnexus/jdtls/bazel-project.json': JSON.stringify({
      javaMajor: 25,
      classpath: ['bazel-out/lib/dependency.jar'],
      sourcePaths: ['src/main/java'],
      outputPath: 'bazel-out/classes',
    }),
    'src/main/java/Sample.java': 'class Sample {}',
  });
  const { workspace, java } = javaSettings(root);
  assert.equal(workspace.usesBazel, true);
  assert.equal(workspace.buildSystems[0].importMode, 'external-model');
  assert.equal(workspace.importBuildTools(), true);
  assert.deepEqual(java.project.referencedLibraries.include, [path.join(root, 'bazel-out/lib/dependency.jar')]);
  assert.deepEqual(java.project.sourcePaths, ['src/main/java']);
  assert.equal(java.project.outputPath, 'bazel-out/classes');
});

test('uses full Bazel runtime binaries for JDT navigation while preserving compile headers', () => {
  const root = fixture({
    'lib/header_spring-context.jar': '',
    'lib/processed_spring-context.jar': '',
    'lib/compile-only.jar': '',
  });
  const header = path.join(root, 'lib/header_spring-context.jar');
  const binary = path.join(root, 'lib/processed_spring-context.jar');
  const compileOnly = path.join(root, 'lib/compile-only.jar');
  assert.deepEqual(jdtlsResolutionClasspath({
    classpath: [header, compileOnly],
    runtimeClasspath: [binary],
  }), [compileOnly, binary].sort());
});

test('generates and caches an exact Bazel JavaInfo classpath model', async () => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "sample")',
    'BUILD.bazel': 'java_library(name = "app", srcs = glob(["src/main/java/**/*.java"]))',
    'src/main/java/example/Sample.java': 'package example; class Sample {}',
  });
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${path.join(root, 'execroot')}'`,
    'elif [ "$1" = "cquery" ]; then',
    "  printf '//:app\\texternal/maven/spring-context.jar\\tbazel-out/app.jar\\n'",
    'elif [ "$1" = "build" ]; then',
    `  mkdir -p '${path.join(root, 'execroot/external/maven')}' '${path.join(root, 'execroot/bazel-out')}'`,
    `  : > '${path.join(root, 'execroot/external/maven/spring-context.jar')}'`,
    `  : > '${path.join(root, 'execroot/bazel-out/app.jar')}'`,
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const generated = await ensureBazelProjectModel(root);
    assert.equal(generated.status, 'generated');
    assert.equal(generated.classpathEntries, 2);

    const model = JdtlsWorkspace.inspect(root).bazelProjectModel!;
    assert.deepEqual(model.classpath, [
      path.join(root, 'execroot/bazel-out/app.jar'),
      path.join(root, 'execroot/external/maven/spring-context.jar'),
    ]);
    assert.deepEqual(model.runtimeClasspath, model.classpath);
    assert.deepEqual(model.sourcePaths, ['src/main/java']);

    fs.writeFileSync(fakeBazel, '#!/bin/sh\nexit 99\n');
    const cached = await ensureBazelProjectModel(root);
    assert.equal(cached.status, 'cached');
    assert.equal(cached.classpathEntries, 2);
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('prepares many Bazel roots with bounded concurrency and per-root results', async () => {
  const roots = Array.from({ length: 7 }, (_, index) => ({
    id: `bazel:app-${index}`,
    workspacePath: `/repo/app-${index}`,
    systems: ['bazel'],
  }));
  let active = 0;
  let maximumActive = 0;
  const report = await prepareBazelProjectModels(roots, {
    concurrency: 3,
    timeoutMs: 2_000,
    generate: async (workspacePath) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: workspacePath.endsWith('3') ? 'failed' : 'generated' };
    },
  });
  assert.equal(report.concurrency, 3);
  assert.equal(maximumActive, 3);
  assert.equal(report.roots.length, 7);
  assert.equal(report.roots.filter((result) => result.status === 'generated').length, 6);
  assert.equal(report.roots.find((result) => result.rootId === 'bazel:app-3')?.status, 'failed');
  assert.equal(report.timedOut, false);
});

test('stops scheduling Bazel roots when the repository-wide budget expires', async () => {
  const roots = Array.from({ length: 3 }, (_, index) => ({
    id: `bazel:slow-${index}`,
    workspacePath: `/repo/slow-${index}`,
    systems: ['bazel'],
  }));
  let started = 0;
  const report = await prepareBazelProjectModels(roots, {
    concurrency: 1,
    timeoutMs: 25,
    generate: async (_workspacePath, options) => {
      started += 1;
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'failed', reason: 'aborted' };
    },
  });
  assert.equal(report.timedOut, true);
  assert.equal(started, 1);
  assert.equal(report.roots.length, 3);
  assert.ok(report.roots.every((result) => result.status === 'failed'));
});

test('keeps mixed build systems and provider overrides distinct', () => {
  const root = fixture({
    'pom.xml': '<project/>',
    'build.gradle': 'plugins { id "java" }',
    'MODULE.bazel': 'module(name = "mixed")',
    'src/main/java/Sample.java': 'class Sample {}',
  });
  process.env.GITNEXUS_JDT_GRADLE_IMPORT = '0';
  try {
    const { workspace, java } = javaSettings(root);
    assert.deepEqual(workspace.buildSystems.map((system) => system.kind), ['gradle', 'maven', 'bazel']);
    assert.equal(java.import.gradle.enabled, false);
    assert.equal(java.import.maven.enabled, true);
    assert.equal(workspace.buildImportEnabled('bazel'), true);
    assert.equal(workspace.buildImportStatuses().find((status) => status.kind === 'bazel')?.status, 'missing-external-model');
    assert.equal(workspace.importBuildTools(), true);
  } finally {
    delete process.env.GITNEXUS_JDT_GRADLE_IMPORT;
  }
});

test('discovers and routes a poly-build monorepo by independent build root', () => {
  const root = fixture({
    'gradle/app/settings.gradle': 'rootProject.name = "app"',
    'gradle/app/build.gradle': 'plugins { id "java" }',
    'gradle/app/src/main/java/App.java': 'class App {}',
    'tools/standalone/build.gradle.kts': 'plugins { java }',
    'tools/standalone/src/main/java/Tool.java': 'class Tool {}',
    'maven/reactor/pom.xml': '<project><modules><module>child</module></modules></project>',
    'maven/reactor/child/pom.xml': '<project/>',
    'maven/reactor/child/src/main/java/Child.java': 'class Child {}',
    'vendor/independent/pom.xml': '<project/>',
    'vendor/independent/src/main/java/Vendor.java': 'class Vendor {}',
    'bazel/service/MODULE.bazel': 'module(name = "service")',
    'bazel/service/src/main/java/Service.java': 'class Service {}',
    'scratch/Loose.java': 'class Loose {}',
  });
  const roots = discoverJavaBuildRoots(root);
  assert.deepEqual(roots.map((buildRoot) => buildRoot.id).sort(), [
    'bazel:bazel/service',
    'gradle:gradle/app',
    'gradle:tools/standalone',
    'maven:maven/reactor',
    'maven:vendor/independent',
    'unmanaged:.',
  ].sort());
  const owner = (relativePath: string) => ownerBuildRoot(path.join(root, relativePath), roots)?.id;
  assert.equal(owner('gradle/app/src/main/java/App.java'), 'gradle:gradle/app');
  assert.equal(owner('maven/reactor/child/src/main/java/Child.java'), 'maven:maven/reactor');
  assert.equal(owner('bazel/service/src/main/java/Service.java'), 'bazel:bazel/service');
  assert.equal(owner('scratch/Loose.java'), 'unmanaged:.');
  const unmanaged = roots.find((buildRoot) => buildRoot.id === 'unmanaged:.')!;
  assert.equal(unmanaged.excludedRoots.length, 5);
  const unmanagedWorkspace = JdtlsWorkspace.inspect(unmanaged.workspacePath, {
    buildSystems: unmanaged.systems,
    excludedRoots: unmanaged.excludedRoots,
  });
  assert.equal(unmanagedWorkspace.sourceFileCount, 1);
  assert.equal(unmanagedWorkspace.requiredJavaMajor, undefined);
  assert.deepEqual(unmanagedWorkspace.importExclusions.sort(), [
    'bazel/service/**',
    'gradle/app/**',
    'maven/reactor/**',
    'tools/standalone/**',
    'vendor/independent/**',
  ]);
  const sessionDataDirs = roots.slice(1, 3).map((buildRoot) => {
    const workspace = JdtlsWorkspace.inspect(buildRoot.workspacePath, {
      buildSystems: buildRoot.systems,
      excludedRoots: buildRoot.excludedRoots,
    });
    const launch = createJdtlsProcessLaunch(buildRoot.workspacePath, workspace, runtime);
    return launch.args[launch.args.indexOf('-data') + 1];
  });
  assert.notEqual(sessionDataDirs[0], sessionDataDirs[1]);
});

test('shards forty build roots across four persistent multi-project workspaces', (t) => {
  const repository = fixture({});
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const roots = Array.from({ length: 40 }, (_, index) => {
    const workspacePath = path.join(repository, `service-${String(index + 1).padStart(2, '0')}`);
    fs.mkdirSync(path.join(workspacePath, 'src/main/java/example'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'MODULE.bazel'), `module(name = "service_${index + 1}")`);
    fs.writeFileSync(path.join(workspacePath, 'src/main/java/example/App.java'), `package example; class App${index + 1} {}`);
    const jar = path.join(workspacePath, 'bazel-out/lib/dependency.jar');
    fs.mkdirSync(path.dirname(jar), { recursive: true });
    fs.writeFileSync(jar, '');
    fs.mkdirSync(path.join(workspacePath, '.gitnexus/jdtls'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.gitnexus/jdtls/bazel-project.json'), JSON.stringify({
      javaMajor: index % 2 === 0 ? 21 : 25,
      classpath: [jar],
      runtimeClasspath: [jar],
      sourcePaths: ['src/main/java'],
      generatedSourcePaths: [],
      configurationHash: `config-${index + 1}`,
    }));
    return {
      id: `bazel:service-${String(index + 1).padStart(2, '0')}`,
      workspacePath,
      relativePath: `service-${String(index + 1).padStart(2, '0')}`,
      systems: ['bazel'] as const,
      excludedRoots: [],
    };
  });
  const shards = planJdtlsBuildRootShards(roots, 4);
  assert.equal(shards.length, 4);
  assert.deepEqual(shards.map((shard) => shard.roots.length), [10, 10, 10, 10]);
  assert.equal(new Set(shards.flatMap((shard) => shard.roots.map((root) => root.id))).size, 40);

  const prepared = prepareJdtlsShardWorkspace(repository, shards[0]);
  assert.equal(prepared.projectModels.length, 10);
  for (const model of prepared.projectModels) {
    assert.ok(model.buildRootId.startsWith('bazel:service-'));
    assert.ok(model.projectName.startsWith('gitnexus-bazel-'));
    assert.equal(model.sourcePaths.length, 1);
    assert.equal(model.compileClasspath.length, 1);
    assert.ok(model.javaMajor === 21 || model.javaMajor === 25);
    const projectPath = path.join(prepared.workspacePath, 'projects', model.projectName);
    const project = fs.readFileSync(path.join(projectPath, '.project'), 'utf8');
    const classpath = fs.readFileSync(path.join(projectPath, '.classpath'), 'utf8');
    assert.match(project, /<linkedResources><\/linkedResources>/);
    assert.ok(fs.statSync(path.join(projectPath, 'source-0')).isDirectory());
    assert.match(classpath, /kind="src"/);
    assert.match(classpath, /kind="lib"/);
    assert.match(fs.readFileSync(path.join(projectPath, '.gitnexus-project.json'), 'utf8'), new RegExp(model.buildRootId));
  }
});

test('generates an Eclipse fallback project when native Gradle import is unavailable', (t) => {
  const repository = fixture({
    'gradle-app/build.gradle': 'plugins { id "java" }',
    'gradle-app/src/main/java/example/App.java': 'package example; class App {}',
    'gradle-app/lib/dependency.jar': '',
    'gradle-app/.classpath': [
      '<classpath>',
      '  <classpathentry kind="src" path="src/main/java"/>',
      '  <classpathentry kind="lib" path="lib/dependency.jar"/>',
      '</classpath>',
    ].join('\n'),
  });
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const root = discoverJavaBuildRoots(repository)[0];
  const prepared = prepareJdtlsShardWorkspace(repository, planJdtlsBuildRootShards([root], 1)[0]);
  const model = prepared.projectModels[0];
  assert.equal(model.modelSource, 'eclipse-classpath');
  assert.deepEqual(model.sourcePaths, [path.join(root.workspacePath, 'src/main/java')]);
  assert.deepEqual(model.compileClasspath, [path.join(root.workspacePath, 'lib/dependency.jar')]);
});
