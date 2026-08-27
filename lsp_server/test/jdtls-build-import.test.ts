import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createJdtlsProcessLaunch,
  discoverJavaBuildRoots,
  JdtlsRuntime,
  JdtlsWorkspace,
  jdtlsJavaCandidates,
  jdtlsResolutionClasspath,
  ownerBuildRoot,
} from '../adapters/java/jdtls-runtime.js';
import { ensureBazelProjectModel, prepareBazelProjectModels, resolveBazelTargetScope } from '../adapters/java/bazel-project-model.js';
import { planJdtlsBuildRootShards, prepareJdtlsShardWorkspace } from '../adapters/java/jdtls-sharding.js';
import { isJdtlsEmptyTypeDefinitionResponse } from '../adapters/java/jdtls-adapter.js';
import {
  createBazelSourceInventory,
  sourceInventoryHash,
  validateBazelSourceJarEntry,
} from '../adapters/java/bazel-source-inventory.js';

const runtime: JdtlsRuntime = {
  jdkJavaBin: '/jdk/25/bin/java',
  jdkMajorVersion: 25,
  equinoxLauncherJar: '/jdtls/launcher.jar',
  osgiConfigDir: '/jdtls/config',
};

test('resolves a deterministic Java target scope before configured analysis', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bazel-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeBazel = path.join(root, 'bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    'case "$*" in',
    '  *"attr(\\\"tags\\\""*) printf "%s\\n" "//reports:coverage" ;;',
    '  *"//custom:app"*) printf "%s\\n" "springboot rule //custom:app" ;;',
    '  *) printf "%s\\n" "java_library rule //service:lib" "java_test rule //service:lib-test" "java_library rule //reports:coverage" "sonarqube rule //service:service-sonar" ;;',
    'esac',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  const progress: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => progress.push(values.map(String).join(' '));
  let resolved;
  try {
    resolved = await resolveBazelTargetScope(root, fakeBazel, {
      includeTargetPatterns: ['//...'], includeRuleKinds: ['java_library', 'java_test'],
      explicitTargets: ['//custom:app'], excludeTargetNamePatterns: ['.*-sonar$'],
      excludeLabels: [], excludeTags: ['coverage'],
    }, 'scope-hash', 5_000);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(resolved.targetQuery, 'set(//custom:app //service:lib //service:lib-test)');
  assert.deepEqual(resolved.resolvedLabels, ['//custom:app', '//service:lib', '//service:lib-test']);
  assert.ok(resolved.excluded.some((value) => value.label === '//reports:coverage' && value.reason === 'tag:coverage'));
  assert.ok(resolved.excluded.some((value) => value.label === '//service:service-sonar'));
  assert.ok(progress.some((line) => line.includes('[bazel:scope-discovery-1-of-1] started')));
  assert.ok(progress.some((line) => line.includes('[bazel:scope-discovery-1-of-1] completed')));
  assert.ok(progress.some((line) => line.includes('[bazel:scope] resolved 3 selected targets; 2 excluded')));
});

test('discovers user-local Linux JDK installations used by the ASM worker', (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-specific discovery path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-jdk-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const java = path.join(home, '.local/jdks/temurin-21/bin/java');
  fs.mkdirSync(path.dirname(java), { recursive: true });
  fs.writeFileSync(java, '');
  assert.ok(jdtlsJavaCandidates(home).includes(java));
});

test('normalizes only JDT LS empty type-definition envelopes to nullable results', () => {
  const emptyEnvelope = new Error(
    'Request textDocument/typeDefinition failed: '
    + 'The received response has neither a result nor an error property.',
  );
  assert.equal(isJdtlsEmptyTypeDefinitionResponse('textDocument/typeDefinition', emptyEnvelope), true);
  assert.equal(isJdtlsEmptyTypeDefinitionResponse('textDocument/definition', emptyEnvelope), false);
  assert.equal(isJdtlsEmptyTypeDefinitionResponse(
    'textDocument/typeDefinition', new Error('Request failed: project unavailable'),
  ), false);
});

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-build-import-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return root;
}

function fakeBepPrelude(): string[] {
  return [
    'for argument in "$@"; do',
    '  case "$argument" in',
    '    --build_event_json_file=*) BEP_FILE=${argument#*=} ;;',
    '  esac',
    'done',
  ];
}

function fakeBepManifestWrite(relativePaths: string[], nested = false): string {
  assert.ok(relativePaths.length > 0);
  const bepFile = (relativePath: string) => ({
    name: path.posix.basename(relativePath),
    pathPrefix: path.posix.dirname(relativePath).split('/').filter(Boolean),
  });
  const events: unknown[] = [];
  if (nested && relativePaths.length > 1) {
    events.push({
      id: { namedSet: { id: 'leaf-manifests' } },
      namedSetOfFiles: { files: relativePaths.slice(1).map(bepFile) },
    });
    events.push({
      id: { namedSet: { id: 'root-manifests' } },
      namedSetOfFiles: { files: [bepFile(relativePaths[0])], fileSets: [{ id: 'leaf-manifests' }] },
    });
  } else {
    events.push({
      id: { namedSet: { id: 'root-manifests' } },
      namedSetOfFiles: { files: relativePaths.map(bepFile) },
    });
  }
  events.push({
    id: { targetCompleted: { label: '//:aspect-root', aspect: 'gitnexus_source_aspect' } },
    completed: {
      success: true,
      outputGroup: [{ name: 'gitnexus_source_manifest', fileSets: [{ id: 'root-manifests' }] }],
    },
  });
  const quotedEvents = events.map((event) => `'${JSON.stringify(event)}'`).join(' ');
  return `  printf '%s\\n' ${quotedEvents} > "$BEP_FILE"`;
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

test('generates and refreshes an exact Bazel JavaInfo classpath and source model', async () => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "sample")',
    'BUILD.bazel': 'java_library(name = "app", srcs = glob(["src/main/java/**/*.java"]))',
    'defs.bzl': 'JAVA_TAG = "java"\n',
    'src/main/java/example/Sample.java': 'package example; class Sample {}',
  });
  const fakeBazel = path.join(root, 'fake-bazel');
  const cqueryLog = path.join(root, 'cquery.log');
  const buildLog = path.join(root, 'build.log');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${path.join(root, 'execroot')}'`,
    'elif [ "$1" = "cquery" ]; then',
    `  printf '%s\\n' "$*" >> '${cqueryLog}'`,
    "  printf '//:app\\tC:external/maven/spring-context.jar\\tC:bazel-out/app.jar\\tR:external/maven/spring-context.jar\\tR:bazel-out/app.jar\\n'",
    'elif [ "$1" = "build" ]; then',
    `  printf '%s\n' "$*" >> '${buildLog}'`,
    `  mkdir -p '${path.join(root, 'execroot/external/maven')}' '${path.join(root, 'execroot/bazel-out')}'`,
    `  : > '${path.join(root, 'execroot/external/maven/spring-context.jar')}'`,
    `  : > '${path.join(root, 'execroot/bazel-out/app.jar')}'`,
    `  printf '%s\n' 'stale manifest deliberately not reported by BEP' > '${path.join(root, 'execroot/bazel-out/stale.gitnexus-sources.json')}'`,
    `  printf '%s\n' '{"label":"//:app","ruleKind":"java_library","dependencies":[{"label":"//shared:api","attribute":"deps"}],"sources":[{"path":"src/main/java/example/Sample.java","shortPath":"src/main/java/example/Sample.java","isSource":true}],"compileArtifacts":["bazel-out/app.jar"],"runtimeArtifacts":["bazel-out/app.jar"],"sourceJars":[]}' > '${path.join(root, 'execroot/bazel-out/app.gitnexus-sources.json')}'`,
    `  printf '%s\n' '{"label":"//shared:api","ruleKind":"java_library","dependencies":[],"sources":[],"compileArtifacts":["external/maven/spring-context.jar"],"runtimeArtifacts":["external/maven/spring-context.jar"],"sourceJars":[]}' > '${path.join(root, 'execroot/bazel-out/shared.gitnexus-sources.json')}'`,
    fakeBepManifestWrite([
      'bazel-out/app.gitnexus-sources.json', 'bazel-out/shared.gitnexus-sources.json',
    ], true),
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
    assert.ok(generated.sourceInventoryPath);
    assert.ok(generated.handoffPath && fs.existsSync(generated.handoffPath));
    const inventory = JSON.parse(fs.readFileSync(generated.sourceInventoryPath, 'utf8'));
    assert.equal(inventory.comparison.repositorySources, 1);
    assert.equal(inventory.comparison.configuredRepositorySources, 1);
    assert.equal(generated.crawlSources?.length, 1);
    assert.equal(generated.configuredTargets?.[0]?.ruleKind, 'java_library');
    assert.deepEqual(generated.configuredTargets?.[0]?.dependencies, [
      { label: '//shared:api', attribute: 'deps' },
    ]);
    assert.equal(generated.configuredTargets?.[0]?.compileArtifacts?.length, 1);
    assert.equal(generated.configuredTargets?.some((target) => target.label.includes('stale')), false);
    assert.equal(fs.existsSync(path.join(root, '.gitnexus/jdtls/bazel-aspect-build.bep.json')), false);
    assert.ok(fs.readFileSync(cqueryLog, 'utf8').trim().split('\n').every((command) =>
      command.includes('"C:"') && command.includes('"R:"') && command.includes('"S:"')
        && command.includes('if len(') && command.includes('else ""')
    ));
    assert.equal(fs.readFileSync(buildLog, 'utf8').includes('--keep_going'), false);

    const refreshed = await ensureBazelProjectModel(root);
    assert.equal(refreshed.status, 'generated');
    assert.equal(refreshed.classpathEntries, 2);
    assert.equal(fs.readFileSync(cqueryLog, 'utf8').trim().split('\n').length, 2);

    const forbiddenBazelCall = path.join(root, 'forbidden-bazel-call');
    fs.writeFileSync(fakeBazel, [
      '#!/bin/sh',
      `: > '${forbiddenBazelCall}'`,
      'exit 99',
    ].join('\n'));
    const prebuilt = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(prebuilt.status, 'cached');
    assert.equal(prebuilt.buildMode, 'prebuilt');
    assert.equal(prebuilt.crawlSources?.length, 1);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);

    const mismatchedScope = await ensureBazelProjectModel(root, {
      buildMode: 'prebuilt', targetQuery: 'set(//other:lib)',
    });
    assert.equal(mismatchedScope.status, 'failed');
    assert.match(mismatchedScope.reason ?? '', /target query/);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);

    const compiledJar = path.join(root, 'execroot/bazel-out/app.jar');
    fs.writeFileSync(compiledJar, 'tampered');
    const staleArtifact = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(staleArtifact.status, 'failed');
    assert.match(staleArtifact.reason ?? '', /changed after preparation/);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);
    fs.writeFileSync(compiledJar, '');

    const sourcePath = path.join(root, 'src/main/java/example/Sample.java');
    const originalSource = fs.readFileSync(sourcePath, 'utf8');
    fs.writeFileSync(sourcePath, `${originalSource}\n// stale`);
    const staleSource = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(staleSource.status, 'failed');
    assert.match(staleSource.reason ?? '', /source changed after preparation/);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);
    fs.writeFileSync(sourcePath, originalSource);

    const buildPath = path.join(root, 'BUILD.bazel');
    const originalBuild = fs.readFileSync(buildPath, 'utf8');
    fs.writeFileSync(buildPath, `${originalBuild}\n# changed configuration`);
    const staleConfiguration = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(staleConfiguration.status, 'failed');
    assert.match(staleConfiguration.reason ?? '', /configuration files changed/);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);
    fs.writeFileSync(buildPath, originalBuild);

    const extensionPath = path.join(root, 'defs.bzl');
    fs.appendFileSync(extensionPath, '# changed Starlark configuration\n');
    const staleExtension = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(staleExtension.status, 'failed');
    assert.match(staleExtension.reason ?? '', /configuration files changed/);
    assert.equal(fs.existsSync(forbiddenBazelCall), false);

    fs.writeFileSync(extensionPath, 'JAVA_TAG = "java"\n');
    const failedPreparation = await ensureBazelProjectModel(root);
    assert.equal(failedPreparation.status, 'failed');
    assert.equal(fs.existsSync(generated.handoffPath!), false);
    const afterFailedPreparation = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(afterFailedPreparation.status, 'failed');
    assert.match(afterFailedPreparation.reason ?? '', /invalid or missing handoff|ENOENT/);
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('uses the recursive build aspect as the authoritative graph for configured scopes', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "recursive")',
    'BUILD.bazel': 'java_library(name = "app", srcs = ["App.java"], deps = ["@third_party//:api"])',
    'App.java': 'class App {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executionRoot = path.join(root, 'execroot');
  const cqueryMarker = path.join(root, 'unexpected-cquery');
  const buildLog = path.join(root, 'build.log');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "query" ]; then',
    '  case "$*" in',
    '    *"attr(\\\"tags\\\""*) exit 0 ;;',
    '    *) printf "%s\\n" "java_library rule //:app" ;;',
    '  esac',
    'elif [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${executionRoot}'`,
    'elif [ "$1" = "cquery" ]; then',
    `  : > '${cqueryMarker}'`,
    '  exit 91',
    'elif [ "$1" = "build" ]; then',
    `  printf '%s\\n' "$*" > '${buildLog}'`,
    `  mkdir -p '${path.join(executionRoot, 'bazel-out')}' '${path.join(executionRoot, 'external/third_party')}'`,
    `  : > '${path.join(executionRoot, 'bazel-out/app-hjar.jar')}'`,
    `  : > '${path.join(executionRoot, 'bazel-out/app.jar')}'`,
    `  : > '${path.join(executionRoot, 'external/third_party/api-hjar.jar')}'`,
    `  : > '${path.join(executionRoot, 'external/third_party/api.jar')}'`,
    `  printf '%s\\n' '{"label":"//:app","ruleKind":"java_library","hasJavaInfo":true,"dependencies":[{"label":"//:bridge","attribute":"deps"}],"sources":[{"path":"App.java","shortPath":"App.java","isSource":true}],"compileArtifacts":["bazel-out/app-hjar.jar"],"runtimeArtifacts":["bazel-out/app.jar"],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/app.gitnexus-sources.json')}'`,
    `  printf '%s\\n' '{"label":"//:bridge","ruleKind":"custom_wrapper","hasJavaInfo":false,"dependencies":[{"label":"@third_party//:api","attribute":"deps"}],"sources":[],"compileArtifacts":[],"runtimeArtifacts":[],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/bridge.gitnexus-sources.json')}'`,
    `  printf '%s\\n' '{"label":"@third_party//:api","ruleKind":"java_library","hasJavaInfo":true,"dependencies":[],"sources":[],"compileArtifacts":["external/third_party/api-hjar.jar"],"runtimeArtifacts":["external/third_party/api.jar"],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/api.gitnexus-sources.json')}'`,
    fakeBepManifestWrite([
      'bazel-out/app.gitnexus-sources.json', 'bazel-out/bridge.gitnexus-sources.json',
      'bazel-out/api.gitnexus-sources.json',
    ], true),
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const result = await ensureBazelProjectModel(root, {
      targetScope: {
        includeTargetPatterns: ['//...'], includeRuleKinds: ['java_library'], explicitTargets: [],
        excludeTargetNamePatterns: [], excludeLabels: [], excludeTags: [],
      },
      scopeConfigHash: 'scope-hash',
    });
    assert.equal(result.status, 'generated', result.reason);
    assert.equal(fs.existsSync(cqueryMarker), false);
    assert.equal(result.classpathEntries, 2);
    assert.deepEqual(result.configuredTargets?.map((target) => target.label), [
      '@third_party//:api', '//:app', '//:bridge',
    ]);
    const model = JdtlsWorkspace.inspect(root).bazelProjectModel!;
    assert.deepEqual(model.classpath, [
      path.join(executionRoot, 'bazel-out/app-hjar.jar'),
      path.join(executionRoot, 'external/third_party/api-hjar.jar'),
    ]);
    assert.match(fs.readFileSync(buildLog, 'utf8'), /gitnexus_java_artifacts/);
    const aspect = fs.readFileSync(path.join(root, '.gitnexus/jdtls/bazel-source-aspect.bzl'), 'utf8');
    assert.match(aspect, /load\("@rules_java\/\/java\/private:java_info\.bzl", "JavaInfo"\)/);
    assert.doesNotMatch(aspect, /java\/common:java_info\.bzl/);
    assert.match(aspect, /attr_aspects = \["deps", "exports", "runtime_deps", "plugins"\]/);
    assert.match(aspect, /java_info\.compile_jars/);
    assert.match(aspect, /java_info\.runtime_output_jars/);
    assert.match(aspect, /java_info\.source_jars/);
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('fails safely and removes temporary BEP data when the aspect output group is missing', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "missing_bep_group")',
    'BUILD.bazel': 'java_library(name = "app", srcs = ["App.java"])',
    'App.java': 'class App {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executionRoot = path.join(root, 'execroot');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${executionRoot}'`,
    'elif [ "$1" = "cquery" ]; then',
    '  printf "//:app\\tC:bazel-out/app.jar\\tR:bazel-out/app.jar\\n"',
    'elif [ "$1" = "build" ]; then',
    `  mkdir -p '${path.join(executionRoot, 'bazel-out')}'`,
    `  : > '${path.join(executionRoot, 'bazel-out/app.jar')}'`,
    `  printf '%s\\n' '{"label":"//:app","sources":[],"compileArtifacts":["bazel-out/app.jar"],"runtimeArtifacts":["bazel-out/app.jar"],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/app.gitnexus-sources.json')}'`,
    `  printf '%s\\n' '{"id":{"namedSet":{"id":"orphan"}},"namedSetOfFiles":{"files":[{"name":"app.gitnexus-sources.json","pathPrefix":["bazel-out"]}]}}' > "$BEP_FILE"`,
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const result = await ensureBazelProjectModel(root);
    assert.equal(result.status, 'failed');
    assert.match(result.reason ?? '', /no gitnexus_source_manifest output group/);
    assert.equal(fs.existsSync(path.join(root, '.gitnexus/jdtls/bazel-aspect-build.bep.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.gitnexus/jdtls/bazel-handoff.json')), false);
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('prebuilt mode fails without a handoff and never invokes Bazel', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "no_handoff")',
    'BUILD.bazel': 'java_library(name = "app", srcs = ["App.java"])',
    'App.java': 'class App {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const called = path.join(root, 'bazel-was-called');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, ['#!/bin/sh', `: > '${called}'`, 'exit 99'].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const result = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(result.status, 'failed');
    assert.match(result.reason ?? '', /invalid or missing handoff|ENOENT/);
    assert.equal(fs.existsSync(called), false);
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('builds a repository-union Bazel source inventory and content-deduplicates source JARs', async (t) => {
  const root = fixture({
    'src/main/java/example/Original.java': 'package example; class Original {}\n',
    'execroot/bazel-out/generated/example/Generated.java': 'package example; class Generated {}\n',
    'jar-input/example/Original.java': 'package example; class Original {}\n',
    'jar-input/example/Generated.java': 'package example; class Generated {}\n',
    'jar-input/example/JarOnly.java': 'package example; class JarOnly {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceJar = path.join(root, 'sources-src.jar');
  execFileSync('zip', ['-q', '-r', sourceJar, '.'], { cwd: path.join(root, 'jar-input') });
  const original = path.join(root, 'src/main/java/example/Original.java');
  const generated = path.join(root, 'execroot/bazel-out/generated/example/Generated.java');
  const inventory = await createBazelSourceInventory({
    workspacePath: root,
    configurationHash: 'configuration',
    targetQuery: '//...',
    repositorySources: [original],
    targets: [{
      label: '//:lib',
      directSources: [
        { path: original, shortPath: 'src/main/java/example/Original.java', isSource: true },
        { path: generated, isSource: false },
      ],
      sourceJars: [sourceJar],
    }],
    extractionRoot: path.join(root, '.gitnexus/jdtls/bazel-sources/configuration'),
  });
  assert.equal(inventory.comparison.repositorySources, 1);
  assert.equal(inventory.comparison.configuredRepositorySources, 1);
  assert.equal(inventory.comparison.generatedSources, 1);
  assert.equal(inventory.comparison.sourceJarOnlySources, 1);
  assert.equal(inventory.comparison.duplicateSources, 2);
  assert.equal(inventory.sources.length, 3);
  assert.ok(inventory.sources.every((source) => source.targetLabels.includes('//:lib')));
  assert.match(inventory.sources.find((source) => source.path === original)!.analysisPath, /bazel-sources/);
  const jarHash = createHash('sha256').update(fs.readFileSync(sourceJar)).digest('hex').slice(0, 24);
  assert.ok(inventory.sources.some((source) => source.analysisPath.includes(jarHash)));
});

test('retains every repository, configured-source, and source-JAR association after deduplication', async (t) => {
  const java = 'package example; class Same {}\n';
  const root = fixture({
    'one/Same.java': java,
    'two/Same.java': java,
    'jar-one/example/Same.java': java,
    'jar-two/example/Same.java': java,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jarOne = path.join(root, 'one.srcjar');
  const jarTwo = path.join(root, 'two.srcjar');
  execFileSync('zip', ['-q', '-r', jarOne, '.'], { cwd: path.join(root, 'jar-one') });
  execFileSync('zip', ['-q', '-r', jarTwo, '.'], { cwd: path.join(root, 'jar-two') });
  const repositoryOne = path.join(root, 'one/Same.java');
  const repositoryTwo = path.join(root, 'two/Same.java');
  const inventory = await createBazelSourceInventory({
    workspacePath: root,
    configurationHash: 'configuration',
    targetQuery: '//...',
    repositorySources: [repositoryOne, repositoryTwo],
    targets: [
      {
        label: '//:one',
        directSources: [{ path: repositoryOne, isSource: true }],
        sourceJars: [jarOne],
      },
      {
        label: '//:two',
        directSources: [{ path: repositoryTwo, isSource: true }],
        sourceJars: [jarTwo],
      },
    ],
    extractionRoot: path.join(root, '.gitnexus/jdtls/bazel-sources/configuration'),
  });
  assert.equal(inventory.sources.length, 1);
  assert.deepEqual(inventory.sources[0].originalRepositoryPaths, [repositoryOne, repositoryTwo]);
  assert.equal(inventory.sources[0].configuredSourceAssociations.length, 2);
  assert.equal(inventory.sources[0].sourceJarAssociations.length, 2);
  assert.deepEqual(inventory.sources[0].targetLabels, ['//:one', '//:two']);

  const changed = structuredClone(inventory);
  changed.generatedAt = new Date(Date.now() + 1_000).toISOString();
  assert.equal(sourceInventoryHash(changed), sourceInventoryHash(inventory));
  changed.sources[0].sourceJarAssociations[0].targetLabels.push('//:changed');
  assert.notEqual(sourceInventoryHash(changed), sourceInventoryHash(inventory));
});

test('discovers Java from a configured source JAR when the repository has no checked-in Java', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "generated_only")',
    'BUILD.bazel': 'java_library(name = "generated", srcs = [":generated.srcjar"])',
    '.gitnexus/jar-input/example/GeneratedOnly.java': 'package example; class GeneratedOnly {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executionRoot = path.join(root, 'execroot');
  fs.mkdirSync(path.join(executionRoot, 'bazel-out'), { recursive: true });
  const sourceJar = path.join(executionRoot, 'bazel-out/generated.srcjar');
  execFileSync('zip', ['-q', '-r', sourceJar, '.'], { cwd: path.join(root, '.gitnexus/jar-input') });
  fs.writeFileSync(path.join(executionRoot, 'bazel-out/generated.jar'), '');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${executionRoot}'`,
    'elif [ "$1" = "cquery" ]; then',
    '  printf "//:generated\\tC:bazel-out/generated.jar\\tR:bazel-out/generated.jar\\tS:bazel-out/generated.srcjar\\n"',
    'elif [ "$1" = "build" ]; then',
    `  printf '%s\\n' '{"label":"//:generated","sources":[],"compileArtifacts":["bazel-out/generated.jar"],"runtimeArtifacts":["bazel-out/generated.jar"],"sourceJars":["bazel-out/generated.srcjar"]}' > '${path.join(executionRoot, 'bazel-out/generated.gitnexus-sources.json')}'`,
    fakeBepManifestWrite(['bazel-out/generated.gitnexus-sources.json']),
    '  exit 0',
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const result = await ensureBazelProjectModel(root);
    assert.equal(result.status, 'generated');
    assert.equal(result.crawlSources?.length, 1);
    assert.equal(result.crawlSources?.[0]?.origin, 'source_jar');
    assert.equal(result.crawlSources?.[0]?.sourceJarAssociations[0]?.sourceJarEntry, 'example/GeneratedOnly.java');
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('preserves a custom Bazel classpath model while generating its source sidecar', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "custom")',
    'BUILD.bazel': 'java_library(name = "app", srcs = ["App.java"])',
    'App.java': 'class App {}\n',
    'custom-model.json': JSON.stringify({ classpath: ['custom.jar'], sourcePaths: ['.'] }),
    'custom.jar': '',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalModel = fs.readFileSync(path.join(root, 'custom-model.json'), 'utf8');
  const executionRoot = path.join(root, 'execroot');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${executionRoot}'`,
    'elif [ "$1" = "cquery" ]; then',
    '  printf "//:app\\tC:bazel-out/app.jar\\tR:bazel-out/app.jar\\n"',
    'elif [ "$1" = "build" ]; then',
    `  mkdir -p '${path.join(executionRoot, 'bazel-out')}'`,
    `  : > '${path.join(executionRoot, 'bazel-out/app.jar')}'`,
    `  printf '%s\\n' '{"label":"//:app","sources":[{"path":"App.java","shortPath":"App.java","isSource":true}],"compileArtifacts":["bazel-out/app.jar"],"runtimeArtifacts":["bazel-out/app.jar"],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/app.gitnexus-sources.json')}'`,
    fakeBepManifestWrite(['bazel-out/app.gitnexus-sources.json']),
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL = 'custom-model.json';
  try {
    const result = await ensureBazelProjectModel(root);
    assert.equal(result.status, 'cached');
    assert.equal(fs.readFileSync(path.join(root, 'custom-model.json'), 'utf8'), originalModel);
    assert.ok(result.sourceInventoryPath && fs.existsSync(result.sourceInventoryPath));
    assert.equal(result.crawlSources?.[0]?.targetLabels[0], '//:app');
    const prebuilt = await ensureBazelProjectModel(root, { buildMode: 'prebuilt' });
    assert.equal(prebuilt.status, 'cached');
    assert.equal(prebuilt.modelPath, path.join(root, 'custom-model.json'));
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
    delete process.env.GITNEXUS_JDT_BAZEL_PROJECT_MODEL;
  }
});

test('includes Git-tracked unowned Java even under an ignored build directory', async (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "tracked_ignored")',
    'BUILD.bazel': 'java_library(name = "app")',
    '.gitignore': 'build/\n',
    'build/Tracked.java': 'class Tracked {}\n',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'MODULE.bazel', 'BUILD.bazel', '.gitignore'], { cwd: root });
  execFileSync('git', ['add', '-f', 'build/Tracked.java'], { cwd: root });
  const executionRoot = path.join(root, 'execroot');
  const fakeBazel = path.join(root, 'fake-bazel');
  fs.writeFileSync(fakeBazel, [
    '#!/bin/sh',
    ...fakeBepPrelude(),
    'if [ "$1" = "info" ]; then',
    `  printf '%s\\n' '${executionRoot}'`,
    'elif [ "$1" = "cquery" ]; then',
    '  printf "//:app\\tC:bazel-out/app.jar\\tR:bazel-out/app.jar\\n"',
    'elif [ "$1" = "build" ]; then',
    `  mkdir -p '${path.join(executionRoot, 'bazel-out')}'`,
    `  : > '${path.join(executionRoot, 'bazel-out/app.jar')}'`,
    `  printf '%s\\n' '{"label":"//:app","sources":[],"compileArtifacts":["bazel-out/app.jar"],"runtimeArtifacts":["bazel-out/app.jar"],"sourceJars":[]}' > '${path.join(executionRoot, 'bazel-out/app.gitnexus-sources.json')}'`,
    fakeBepManifestWrite(['bazel-out/app.gitnexus-sources.json']),
    'else',
    '  exit 2',
    'fi',
  ].join('\n'));
  fs.chmodSync(fakeBazel, 0o755);
  process.env.GITNEXUS_BAZEL_BIN = fakeBazel;
  try {
    const result = await ensureBazelProjectModel(root);
    assert.equal(result.status, 'generated');
    assert.deepEqual(result.sourceInventoryComparison?.unownedRepositorySources, ['build/Tracked.java']);
    assert.equal(result.crawlSources?.[0]?.path, path.join(root, 'build/Tracked.java'));
  } finally {
    delete process.env.GITNEXUS_BAZEL_BIN;
  }
});

test('rejects unsafe and corrupt Bazel source JARs', async (t) => {
  assert.throws(() => validateBazelSourceJarEntry('../Escape.java', 'unsafe.srcjar'), /Unsafe entry/);
  assert.throws(() => validateBazelSourceJarEntry('/absolute/Escape.java', 'unsafe.srcjar'), /Unsafe entry/);
  assert.throws(() => validateBazelSourceJarEntry('dir\\Escape.java', 'unsafe.srcjar'), /Unsafe entry/);
  assert.throws(() => validateBazelSourceJarEntry('safe/../', 'unsafe.srcjar'), /Unsafe entry/);
  assert.throws(() => validateBazelSourceJarEntry('safe//', 'unsafe.srcjar'), /Unsafe entry/);
  assert.throws(() => validateBazelSourceJarEntry('safe/./', 'unsafe.srcjar'), /Unsafe entry/);
  const root = fixture({ 'broken-src.jar': 'not a zip archive' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(createBazelSourceInventory({
    workspacePath: root,
    configurationHash: 'configuration',
    targetQuery: '//...',
    repositorySources: [],
    targets: [{ label: '//:broken', directSources: [], sourceJars: [path.join(root, 'broken-src.jar')] }],
    extractionRoot: path.join(root, '.gitnexus/jdtls/bazel-sources/configuration'),
  }), /Invalid Bazel source JAR/);
});

test('rejects Java symlinks when source-JAR extraction falls back to unzip', async (t) => {
  const root = fixture({ 'Outside.java': 'class Outside {}\n' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  fs.mkdirSync(input);
  fs.symlinkSync(path.join(root, 'Outside.java'), path.join(input, 'Linked.java'));
  const sourceJar = path.join(root, 'symlink.srcjar');
  execFileSync('zip', ['-q', '-y', sourceJar, 'Linked.java'], { cwd: input });
  const commandBin = path.join(root, 'bin');
  fs.mkdirSync(commandBin);
  fs.symlinkSync(execFileSync('which', ['unzip'], { encoding: 'utf8' }).trim(), path.join(commandBin, 'unzip'));
  const previousPath = process.env.PATH;
  const previousJavaHome = process.env.JAVA_HOME;
  const previousJdtJavaHome = process.env.GITNEXUS_JDT_JAVA_HOME;
  process.env.PATH = commandBin;
  delete process.env.JAVA_HOME;
  delete process.env.GITNEXUS_JDT_JAVA_HOME;
  const extractionRoot = path.join(root, 'extracted');
  try {
    await assert.rejects(createBazelSourceInventory({
      workspacePath: root,
      configurationHash: 'configuration',
      targetQuery: '//...',
      repositorySources: [],
      targets: [{ label: '//:unsafe', directSources: [], sourceJars: [sourceJar] }],
      extractionRoot,
    }), /not safely extracted/);
    const jarHash = createHash('sha256').update(fs.readFileSync(sourceJar)).digest('hex').slice(0, 24);
    assert.equal(fs.existsSync(path.join(extractionRoot, jarHash)), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousJavaHome === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = previousJavaHome;
    if (previousJdtJavaHome === undefined) delete process.env.GITNEXUS_JDT_JAVA_HOME;
    else process.env.GITNEXUS_JDT_JAVA_HOME = previousJdtJavaHome;
  }
});

test('uses package-correct roots for unconventional Bazel repository sources', (t) => {
  const root = fixture({
    'MODULE.bazel': 'module(name = "unconventional")',
    'odd/com/acme/A.java': 'package com.acme; class A { B value; }\n',
    'odd/com/acme/B.java': 'package com.acme; class B {}\n',
    'odd/Misaligned.java': 'package com.acme; class Misaligned {}\n',
    '.gitnexus/jdtls/bazel-project.json': JSON.stringify({
      classpath: [], runtimeClasspath: [], sourcePaths: ['odd/com/acme'], generatedSourcePaths: [],
      sourceInventoryPath: '.gitnexus/jdtls/bazel-source-inventory.json',
    }),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = ['A.java', 'B.java'].map((name) => {
    const sourcePath = path.join(root, 'odd/com/acme', name);
    return {
      path: sourcePath, analysisPath: sourcePath, origin: 'repository',
      contentHash: name, targetLabels: [], originalRepositoryPaths: [sourcePath],
      configuredSourceAssociations: [], sourceJarAssociations: [],
    };
  });
  sources.push({
    path: path.join(root, 'odd/Misaligned.java'), analysisPath: path.join(root, 'odd/Misaligned.java'),
    origin: 'repository', contentHash: 'Misaligned.java', targetLabels: [],
    originalRepositoryPaths: [path.join(root, 'odd/Misaligned.java')],
    configuredSourceAssociations: [], sourceJarAssociations: [],
  });
  fs.writeFileSync(path.join(root, '.gitnexus/jdtls/bazel-source-inventory.json'), JSON.stringify({
    schemaVersion: 2, workspacePath: root, configurationHash: 'configuration', targetQuery: '//...',
    generatedAt: new Date().toISOString(), targets: [], sources,
    comparison: {
      repositorySources: 3, configuredRepositorySources: 0, generatedSources: 0,
      sourceJarOnlySources: 0,
      unownedRepositorySources: ['odd/Misaligned.java', 'odd/com/acme/A.java', 'odd/com/acme/B.java'],
      duplicateSources: 0, crawlSources: 3,
    },
  }));
  const discovered = discoverJavaBuildRoots(root)[0];
  const prepared = prepareJdtlsShardWorkspace(root, planJdtlsBuildRootShards([discovered], 1)[0]);
  assert.ok(prepared.projectModels[0].sourcePaths.includes(path.join(root, 'odd')));
  assert.equal(prepared.projectModels[0].sourceMappings.length, 3);
  assert.match(
    prepared.projectModels[0].sourceMappings.find((mapping) => mapping.sourcePath.endsWith('Misaligned.java'))!.analysisPath,
    /package-corrected.*com[/\\]acme[/\\]Misaligned\.java/,
  );
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
