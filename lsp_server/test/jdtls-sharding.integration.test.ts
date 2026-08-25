import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planJdtlsBuildRootShards, prepareJdtlsShardWorkspace } from '../adapters/java/jdtls-sharding.js';
import type { JavaBuildRoot } from '../adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../registry/lsp-adapter-registry.js';

test('one persistent JDT LS process preserves project isolation and root-local resolution', {
  skip: process.env.GITNEXUS_RUN_JDTLS_INTEGRATION !== '1',
  timeout: 180_000,
}, async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'jdtls-shard-live-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
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
