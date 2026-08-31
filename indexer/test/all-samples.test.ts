import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import lbug from '@ladybugdb/core';
import { findJavaSourceFiles } from '../src/pipeline/java-source-files.js';
import { openLspLadybugDatabase, type LadybugModuleLike } from '../src/lbug/repository.js';
import { ownerBuildRoot } from '../../lsp_server/adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../../lsp_server/registry/lsp-adapter-registry.js';

const REPOSITORY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES_PATH = path.join(REPOSITORY_PATH, 'sample_projects');
const RUN_END_TO_END = process.env.RUN_SAMPLE_INDEXER_E2E === '1';
const SAMPLE_TIMEOUT_MS = positiveIntegerEnvironment('SAMPLE_INDEXER_TIMEOUT_MS', 30 * 60_000);
const SAMPLE_FILTER = process.env.SAMPLE_INDEXER_FILTER
  ? new RegExp(process.env.SAMPLE_INDEXER_FILTER)
  : undefined;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.gitnexus', 'node_modules', 'target', 'build', 'dist', 'bazel-bin',
  'bazel-out', 'bazel-testlogs',
]);

interface SampleInventory {
  name: string;
  path: string;
  filesByLanguage: Map<string, string[]>;
}

const samples = discoverSamples();

test('sample catalog includes every sample directory', () => {
  const directories = fs.readdirSync(SAMPLES_PATH, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(samples.map((sample) => sample.name), directories);
  assert.ok(samples.length > 0, 'sample_projects must contain at least one sample');
});

for (const sample of samples) {
  test(`routes and plans every source in sample: ${sample.name}`, () => {
    const registry = new LspAdapterRegistry();
    const languages = [...sample.filesByLanguage.keys()].sort();
    assert.ok(languages.length > 0, `${sample.name} contains no source supported by the adapter registry`);
    for (const [language, files] of sample.filesByLanguage) {
      assert.ok(files.length > 0);
      assert.ok(registry.getAdapter(language), `${sample.name} has no registered ${language} adapter`);
      for (const file of files) assert.equal(registry.getLanguageForFile(file), language);
    }

    const javaFiles = findJavaSourceFiles(sample.path);
    if (sample.filesByLanguage.has('java')) {
      assert.ok(javaFiles.length > 0, `${sample.name} has Java sources but Java discovery returned none`);
      const roots = registry.getJavaBuildRoots(sample.path);
      assert.ok(roots.length > 0, `${sample.name} did not produce a Java build-root plan`);
      const unowned = javaFiles.filter((file) => !ownerBuildRoot(file, roots));
      assert.deepEqual(unowned, [], `${sample.name} contains Java sources without a build-root owner`);
    } else {
      assert.equal(javaFiles.length, 0, `${sample.name} unexpectedly entered the Java pipeline`);
    }
  });
}

test('runs the real indexer or LSP adapter through every sample', {
  skip: RUN_END_TO_END ? false : 'run npm run test:samples for the external-tool end-to-end suite',
  timeout: SAMPLE_TIMEOUT_MS * Math.max(1, samples.length),
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-link-all-samples-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const selectedSamples = SAMPLE_FILTER
    ? samples.filter((sample) => SAMPLE_FILTER.test(sample.name))
    : samples;
  assert.ok(selectedSamples.length > 0, 'SAMPLE_INDEXER_FILTER did not match a sample');
  for (const sample of selectedSamples) {
    await t.test(sample.name, { timeout: SAMPLE_TIMEOUT_MS }, async () => {
      if (sample.filesByLanguage.has('java')) await runJavaIndexer(sample, temporary);
      else await smokeNonJavaAdapters(sample);
    });
  }
});

function discoverSamples(): SampleInventory[] {
  const registry = new LspAdapterRegistry();
  return fs.readdirSync(SAMPLES_PATH, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const samplePath = path.join(SAMPLES_PATH, entry.name);
      const filesByLanguage = new Map<string, string[]>();
      for (const file of walkSourceFiles(samplePath, registry)) {
        const language = registry.getLanguageForFile(file)!;
        const files = filesByLanguage.get(language) ?? [];
        files.push(file);
        filesByLanguage.set(language, files);
      }
      for (const files of filesByLanguage.values()) files.sort();
      return { name: entry.name, path: samplePath, filesByLanguage };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function walkSourceFiles(directory: string, registry: LspAdapterRegistry): string[] {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('bazel-')) pending.push(entryPath);
      } else if (entry.isFile() && registry.getLanguageForFile(entryPath)) files.push(entryPath);
    }
  }
  return files;
}

async function runJavaIndexer(sample: SampleInventory, temporary: string): Promise<void> {
  const output = path.join(temporary, `${sample.name}.lbug`);
  const prebuilt = hasCompletePrebuiltBazelHandoff(sample);
  const sampleConfigPath = path.join(sample.path, 'index-config.json');
  const configPath = prebuilt && fs.existsSync(sampleConfigPath)
    ? sampleConfigPath
    : path.join(temporary, `${sample.name}.json`);
  if (configPath !== sampleConfigPath) {
    fs.writeFileSync(configPath, JSON.stringify(endToEndConfig(prebuilt), null, 2));
  }
  await runProcess(process.execPath, [
    path.join(REPOSITORY_PATH, 'node_modules/tsx/dist/cli.mjs'),
    path.join(REPOSITORY_PATH, 'indexer/src/cli/build.ts'),
    'build', sample.path,
    '--config', configPath,
    '--output', output,
    '--checkpoint-directory', `${output}.checkpoints`,
    '--no-resume',
  ], sample.name);
  assert.ok(fs.existsSync(output), `${sample.name} did not publish its LadybugDB output`);
  const handle = openLspLadybugDatabase(output, lbug as unknown as LadybugModuleLike);
  try {
    const result = await handle.artifactRepository.connectionForBulkCopy().query(
      'MATCH (document:LspDocument) RETURN count(document) AS documentCount',
    );
    assert.ok(!Array.isArray(result) && result.getAll, 'document count query returned no row set');
    const [row] = await result.getAll();
    await result.close?.();
    assert.ok(Number(row.documentCount) > 0, `${sample.name} published no indexed documents`);
  } finally {
    await handle.close();
  }
}

async function smokeNonJavaAdapters(sample: SampleInventory): Promise<void> {
  const registry = new LspAdapterRegistry();
  try {
    for (const [language, files] of sample.filesByLanguage) {
      const adapter = await registry.getOrStartAdapter(language, sample.path);
      assert.ok(adapter, `${sample.name}: ${language} adapter is unavailable`);
      const representative = files[0]!;
      await adapter.openDocument(representative);
      try {
        const symbols = await adapter.documentSymbols(representative);
        assert.ok(Array.isArray(symbols), `${sample.name}: ${language} returned an invalid symbol response`);
      } finally {
        await adapter.closeDocument(representative);
      }
    }
  } finally {
    await registry.shutdownAll();
  }
}

function runProcess(command: string, args: string[], sampleName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: REPOSITORY_PATH,
      env: process.env,
      stdio: 'inherit',
      detached: useProcessGroup,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child.pid, useProcessGroup, 'SIGTERM');
      const forceKill = setTimeout(() => terminateChild(child.pid, useProcessGroup, 'SIGKILL'), 5_000);
      forceKill.unref();
    }, SAMPLE_TIMEOUT_MS);
    timeout.unref();
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`${sampleName} exceeded its ${SAMPLE_TIMEOUT_MS} ms sample timeout`));
      else if (code === 0) resolve();
      else reject(new Error(`${sampleName} indexer exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function terminateChild(pid: number | undefined, processGroup: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(processGroup ? -pid : pid, signal); }
  catch { /* the process already exited */ }
}

function hasCompletePrebuiltBazelHandoff(sample: SampleInventory): boolean {
  const roots = new LspAdapterRegistry().getJavaBuildRoots(sample.path);
  const bazelRoots = roots.filter((root) => root.systems.includes('bazel'));
  return bazelRoots.length > 0 && bazelRoots.every((root) =>
    fs.existsSync(path.join(root.workspacePath, '.gitnexus/jdtls/bazel-handoff.json')));
}

function endToEndConfig(prebuilt: boolean): object {
  return {
    schemaVersion: 1,
    name: 'all-samples-e2e',
    bazel: {
      buildMode: prebuilt ? 'prebuilt' : 'managed',
      scope: {
        includeTargetPatterns: ['//...'],
        includeRuleKinds: ['java_library', 'java_binary', 'java_test'],
        explicitTargets: [],
        excludeTargetNamePatterns: ['.*_deploy_bannedcheck$', '.*-sonar$', '.*-sq$'],
        excludeLabels: [],
        excludeTags: ['coverage', 'reporting-only'],
      },
      preparation: { concurrency: 4, timeoutMs: SAMPLE_TIMEOUT_MS },
    },
    crawl: { profile: 'core', concurrency: 4, resume: false },
    artifacts: { concurrency: 4, maxClasses: 1, fetchSources: false, classpathManifests: [] },
    quality: { failOnFailedBuildRoot: true },
    checkpoints: { directory: null },
  };
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
