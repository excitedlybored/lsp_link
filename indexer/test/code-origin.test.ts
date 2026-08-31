import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  CODE_ORIGINS,
  classifyArtifactCodeOrigin,
  codeOriginForDocumentOrigin,
  isExternalCodeOrigin,
} from '../src/code-origin.js';
import { materializeSymbol } from '../src/ingest/builders.js';
import { JVM_ARTIFACT_SCHEMA_QUERIES } from '../src/artifact/schema.js';
import { ArtifactClasspathResolver } from '../src/artifact/classpath/resolver.js';
import type { ArtifactClasspathProvider } from '../src/artifact/classpath/types.js';
import { LSP_DOCUMENT_SCHEMA, LSP_SYMBOL_SCHEMAS } from '../src/lbug/schema.js';

test('defines and maps every persisted code-origin value', () => {
  assert.deepEqual(CODE_ORIGINS, [
    'repository', 'generated_first_party', 'first_party_artifact',
    'third_party_dependency', 'standard_library', 'unknown',
  ]);
  assert.equal(codeOriginForDocumentOrigin('workspace'), 'repository');
  assert.equal(codeOriginForDocumentOrigin('generated'), 'generated_first_party');
  assert.equal(codeOriginForDocumentOrigin('dependency'), 'third_party_dependency');
  assert.equal(codeOriginForDocumentOrigin('standard_library'), 'standard_library');
  assert.equal(codeOriginForDocumentOrigin('unknown'), 'unknown');
  assert.equal(isExternalCodeOrigin('repository'), false);
  assert.equal(isExternalCodeOrigin('generated_first_party'), false);
  assert.equal(isExternalCodeOrigin('first_party_artifact'), false);
  assert.equal(isExternalCodeOrigin('third_party_dependency'), true);
  assert.equal(isExternalCodeOrigin('standard_library'), true);
  assert.equal(isExternalCodeOrigin('unknown'), true);
});

test('classifies first-party, dependency, standard-library, and unknown artifacts', () => {
  const workspace = path.resolve('/workspace/application');
  assert.equal(classifyArtifactCodeOrigin({
    artifactPath: path.join(workspace, 'target/application.jar'), workspacePath: workspace,
  }), 'first_party_artifact');
  assert.equal(classifyArtifactCodeOrigin({
    artifactPath: '/home/user/.m2/repository/org/example/library/1/library-1.jar',
    workspacePath: workspace, coordinate: 'org.example:library:1',
  }), 'third_party_dependency');
  assert.equal(classifyArtifactCodeOrigin({
    artifactPath: '/opt/jdk-21/lib/jrt-fs.jar', workspacePath: workspace,
  }), 'standard_library');
  assert.equal(classifyArtifactCodeOrigin({
    artifactPath: '/cache/execroot/app/bazel-out/k8-fastbuild/bin/app.jar',
    workspacePath: workspace, providerIds: ['bazel-java-info'],
  }), 'first_party_artifact');
  assert.equal(classifyArtifactCodeOrigin({
    artifactPath: '/unclassified/location/library.jar', workspacePath: workspace,
  }), 'unknown');
});

test('classpath resolution records origin before artifact cache retention', async () => {
  const workspace = path.resolve('/workspace/application');
  const provider: ArtifactClasspathProvider = {
    id: 'explicit-manifest',
    supports: () => true,
    resolveArtifacts: async () => [{
      buildRootId: 'root', providerIds: ['explicit-manifest'], scope: 'runtime', modulePath: false,
      classpathEntryPath: path.join(workspace, 'target/application.jar'),
      binaryJarPath: path.join(workspace, 'target/application.jar'),
    }, {
      buildRootId: 'root', providerIds: ['explicit-manifest'], scope: 'runtime', modulePath: false,
      classpathEntryPath: '/home/user/.m2/repository/org/example/library/1/library-1.jar',
      binaryJarPath: '/home/user/.m2/repository/org/example/library/1/library-1.jar',
      coordinate: 'org.example:library:1',
    }],
  };
  const resolution = await new ArtifactClasspathResolver([provider]).resolveArtifacts({
    root: { id: 'root', workspacePath: workspace, systems: ['maven'] }, documentUris: [],
  });
  assert.deepEqual(resolution.artifacts.map((artifact) => artifact.codeOrigin), [
    'first_party_artifact', 'third_party_dependency',
  ]);
});

test('generated first-party symbols are not classified as external dependencies', () => {
  const symbol = materializeSymbol({
    id: 'document', uri: 'file:///workspace/generated/Message.java', languageId: 'java',
    origin: 'generated', codeOrigin: 'generated_first_party', wasOpened: true,
  }, {
    name: 'Message', kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
  });
  assert.equal(symbol.codeOrigin, 'generated_first_party');
  assert.equal(symbol.isExternal, false);
});

test('persists codeOrigin on source and JVM code-bearing node schemas', () => {
  assert.match(LSP_DOCUMENT_SCHEMA, /codeOrigin STRING/);
  for (const schema of LSP_SYMBOL_SCHEMAS) assert.match(schema, /codeOrigin STRING/);
  for (const table of ['JvmArtifact', 'JvmClass', 'JvmMethod', 'JvmField', 'JvmCallSite']) {
    const schema = JVM_ARTIFACT_SCHEMA_QUERIES.find((query) => query.includes(`TABLE ${table} (`));
    assert.match(schema ?? '', /codeOrigin STRING/);
  }
});
