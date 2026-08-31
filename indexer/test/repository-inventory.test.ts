import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildRepositoryInventory } from '../src/repository/inventory.js';
import { REPOSITORY_INVENTORY_SCHEMA_QUERIES } from '../src/repository/schema.js';
import { RepositoryDocumentProviderRegistry } from '../src/repository/registry.js';
import type { IRepositoryDocumentProvider } from '../src/repository/provider.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures/enterprise-indexer-shape',
);

test('indexes the enterprise repository shape without claiming semantic LSP support', async () => {
  const batch = await buildRepositoryInventory(fixture);
  const documents = new Map(batch.documents.map((document) => [document.relativePath, document]));

  assert.equal(documents.get('src/main/kotlin/example/ExampleWorkflow.kt')?.languageId, 'kotlin');
  assert.equal(documents.get('features/example.feature')?.kind, 'gherkin');
  assert.equal(documents.get('config/application.yaml')?.kind, 'configuration');
  assert.equal(documents.get('build_defs/services.bzl')?.kind, 'build_definition');
  assert.equal(documents.get('MODULE.bazel')?.languageId, 'starlark');
  assert.equal(documents.get('maven_install.json')?.languageId, 'json');

  const declarations = batch.declarations.map(({ kind, name, providerId }) => ({ kind, name, providerId }));
  assert.ok(declarations.some((value) => value.kind === 'class' && value.name === 'ExampleWorkflow'
    && value.providerId === 'kotlin-lexical'));
  assert.ok(declarations.some((value) => value.kind === 'function' && value.name === 'registerByConfiguration'));
  assert.ok(declarations.some((value) => value.kind === 'feature' && value.name === 'Example registration'));
  assert.ok(declarations.some((value) => value.kind === 'scenario' && value.name === 'Register an example workflow'));
  assert.ok(declarations.some((value) => value.kind === 'config_key' && value.name === 'workflow-class'));
  assert.ok(declarations.some((value) => value.kind === 'macro' && value.name === 'example_deploy'));
  assert.ok(batch.declarations.every((value) => value.startLine >= 0 && value.endCharacter >= value.startCharacter));
  assert.ok(batch.documents.every((value) => value.authority === 'structural_lexical'));
  assert.equal(batch.providers.find((value) => value.providerId === 'kotlin-lexical')?.status, 'complete');
});

test('uses a dedicated Maven lock and matching Bzlmod repository name', () => {
  const moduleText = fs.readFileSync(path.join(fixture, 'MODULE.bazel'), 'utf8');
  assert.match(moduleText, /maven\.install\([\s\S]*name\s*=\s*"mvn"/);
  assert.match(moduleText, /lock_file\s*=\s*"\/\/:maven_install\.json"/);
  assert.match(moduleText, /use_repo\(maven, "mvn"\)/);
  assert.match(moduleText, /REPIN=1 bazel run @mvn\/\/:pin/);
  assert.doesNotMatch(moduleText, /MODULE\.bazel\.lock/);
});

test('declares repository evidence separately from semantic LSP tables', () => {
  assert.ok(REPOSITORY_INVENTORY_SCHEMA_QUERIES.some((ddl) => ddl.includes('RepositoryDocument')));
  assert.ok(REPOSITORY_INVENTORY_SCHEMA_QUERIES.some((ddl) => ddl.includes('RepositoryDeclaration')));
  assert.ok(REPOSITORY_INVENTORY_SCHEMA_QUERIES.every((ddl) => !ddl.includes('LspDocument')));
});

test('bounds provider work and isolates a failed document in a large batch', async (t) => {
  const root = fs.mkdtempSync(path.join(path.dirname(fixture), 'provider-scale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 200; index += 1) {
    fs.writeFileSync(path.join(root, `${index}.kt`), `class Type${index}\n`);
  }
  let active = 0;
  let maximumActive = 0;
  let shutdown = false;
  const provider: IRepositoryDocumentProvider = {
    metadata: {
      id: 'bounded-test', version: '1', authority: 'structural_lexical',
      languages: ['kotlin'], capabilities: ['declarations'], includeGlobs: ['**/*.kt'],
      documentKind: 'source',
    },
    supports: (value) => value.endsWith('.kt'),
    languageId: () => 'kotlin',
    async index({ document }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (document.relativePath === '73.kt') throw new Error('intentional provider failure');
      return [{
        kind: 'class', name: path.basename(document.path, '.kt'),
        startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 13,
      }];
    },
    async shutdown() { shutdown = true; },
  };

  const batch = await buildRepositoryInventory(
    root, { concurrency: 7 }, new RepositoryDocumentProviderRegistry([provider]),
  );
  const run = batch.providers[0]!;
  assert.equal(run.discoveredCount, 200);
  assert.equal(run.indexedCount, 199);
  assert.equal(run.errorCount, 1);
  assert.equal(run.status, 'partial');
  assert.match(run.errorsJson, /intentional provider failure/);
  assert.ok(maximumActive <= 7);
  assert.equal(shutdown, true);
});

test('rejects ambiguous routing and structural providers claiming LSP authority', () => {
  const provider = (id: string, authority: 'structural_lexical' | 'semantic_lsp'): IRepositoryDocumentProvider => ({
    metadata: {
      id, version: '1', authority, languages: ['kotlin'], capabilities: [], includeGlobs: ['**/*.kt'],
      documentKind: 'source',
    },
    supports: (value) => value.endsWith('.kt'), languageId: () => 'kotlin', async index() { return []; },
  });
  assert.throws(
    () => new RepositoryDocumentProviderRegistry([provider('invalid', 'semantic_lsp')]),
    /register an ILspAdapter/,
  );
  const registry = new RepositoryDocumentProviderRegistry([
    provider('first', 'structural_lexical'), provider('second', 'structural_lexical'),
  ]);
  assert.throws(() => registry.providerFor('Example.kt'), /Ambiguous repository document providers/);
});
