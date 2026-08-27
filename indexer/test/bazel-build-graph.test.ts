import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBazelBuildGraphBatch } from '../src/bazel/model.js';
import { BAZEL_BUILD_GRAPH_SCHEMA_QUERIES } from '../src/bazel/schema.js';

test('builds a separate Bazel target, source, artifact, and dependency evidence graph', () => {
  const batch = buildBazelBuildGraphBatch([{
    rootId: 'bazel:.', workspacePath: '/workspace', configurationHash: 'config-1',
    configuredTargets: [{
      label: '//service:lib', ruleKind: 'java_library',
      dependencies: [
        { label: '//shared:api', attribute: 'deps' },
        { label: '//runtime:agent', attribute: 'runtime_deps' },
      ],
      directSources: [{ path: '/workspace/service/Service.java', isSource: true }],
      sourceJars: ['/execroot/service-src.jar'],
      compileArtifacts: ['/execroot/service-hjar.jar'],
      runtimeArtifacts: ['/execroot/service.jar'],
    }],
  }]);

  assert.equal(batch.runs.length, 1);
  assert.equal(batch.targets.length, 3);
  assert.equal(batch.targets.find((target) => target.label === '//service:lib')?.selected, true);
  assert.equal(batch.targets.find((target) => target.label === '//shared:api')?.selected, false);
  assert.equal(batch.sources.length, 1);
  assert.equal(batch.artifacts.length, 3);
  assert.deepEqual(
    batch.relations.filter((relation) => relation.kind === 'DEPENDS_ON')
      .map((relation) => relation.attribute),
    ['deps', 'runtime_deps'],
  );
  assert.equal(batch.relations.filter((relation) => relation.kind.endsWith('_ARTIFACT')).length, 3);
});

test('declares Bazel evidence independently from LSP and JVM schemas', () => {
  assert.ok(BAZEL_BUILD_GRAPH_SCHEMA_QUERIES.some((query) =>
    query.startsWith('CREATE NODE TABLE BazelTarget')));
  assert.ok(BAZEL_BUILD_GRAPH_SCHEMA_QUERIES.some((query) =>
    query.includes('FROM BazelTarget TO BazelTarget')));
  assert.ok(BAZEL_BUILD_GRAPH_SCHEMA_QUERIES.every((query) => !query.includes('LspRelation')));
});
