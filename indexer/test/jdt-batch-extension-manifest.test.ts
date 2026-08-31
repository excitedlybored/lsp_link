import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('JDT batch extension is an Eclipse singleton and registers both commands', () => {
  const manifest = fs.readFileSync(path.join(repository, 'jdt_batch_extension/META-INF/MANIFEST.MF'), 'utf8');
  const plugin = fs.readFileSync(path.join(repository, 'jdt_batch_extension/plugin.xml'), 'utf8');
  assert.match(manifest, /Bundle-SymbolicName: io\.gitnexus\.jdt\.batch;singleton:=true/);
  assert.match(plugin, /gitnexus\.java\.collectBatch/);
  assert.match(plugin, /gitnexus\.java\.awaitIndex/);
});
