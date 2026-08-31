import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repository = path.resolve(import.meta.dirname, '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!target) throw new Error('Usage: npm run benchmark:jdt -- REPOSITORY [--config CONFIG]');
const forwarded = process.argv.slice(3);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-batch-benchmark-'));
const variants = [
  { name: 'stop-at-level-1', environment: { GITNEXUS_JDT_DEFAULT_TIERED: '0', GITNEXUS_JDT_TIERED_STOP_LEVEL: '1' } },
  { name: 'default-tiered', environment: { GITNEXUS_JDT_DEFAULT_TIERED: '1' } },
];
const results = [];
try {
  for (const variant of variants) {
    for (const cacheState of ['cold', 'warm']) {
      const repetitions = 3;
      const shared = path.join(root, variant.name, 'shared-index');
      for (let iteration = 0; iteration < repetitions; iteration++) {
        const indexDirectory = cacheState === 'warm' ? shared : path.join(root, variant.name, `cold-${iteration}`);
        const checkpoint = path.join(root, `${variant.name}-${cacheState}-${iteration}.checkpoints`);
        const startedAt = Date.now();
        const measurement = await run([
          path.join(repository, 'node_modules/tsx/dist/cli.mjs'),
          path.join(repository, 'indexer/src/cli/build.ts'), 'crawl', target,
          '--checkpoint-directory', checkpoint, '--no-resume', '--jdt-processes', '1', ...forwarded,
        ], { ...variant.environment, GITNEXUS_JDT_SHARED_INDEX_DIR: indexDirectory });
        results.push({ variant: variant.name, cacheState, iteration: iteration + 1,
          elapsedMs: Date.now() - startedAt, peakProcessTreeRssMiB: measurement.peakRssBytes / 1024 / 1024,
          exitCode: measurement.exitCode, stages: measurement.stages });
        if (measurement.exitCode !== 0) throw new Error(`${variant.name}/${cacheState} failed`);
      }
    }
  }
  const summary = Object.fromEntries(variants.map((variant) => [variant.name, {
    coldMedianMs: median(results.filter((value) => value.variant === variant.name && value.cacheState === 'cold').map((value) => value.elapsedMs)),
    warmMedianMs: median(results.filter((value) => value.variant === variant.name && value.cacheState === 'warm').map((value) => value.elapsedMs)),
    peakRssMiB: Math.max(...results.filter((value) => value.variant === variant.name).map((value) => value.peakProcessTreeRssMiB)),
  }]));
  const current = summary['stop-at-level-1'], candidate = summary['default-tiered'];
  const improvement = (current.warmMedianMs - candidate.warmMedianMs) / current.warmMedianMs;
  const recommendation = improvement >= 0.10 && candidate.peakRssMiB <= current.peakRssMiB * 1.10
    ? 'default-tiered' : 'stop-at-level-1';
  process.stdout.write(`${JSON.stringify({ results, summary, improvement, recommendation }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function run(args, extraEnvironment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repository,
      env: { ...process.env, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'inherit'] });
    let peakRssBytes = 0;
    const stages = [];
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^\[jdtls-stage\] (\{.*\})$/.exec(line);
        if (match) {
          try { stages.push(JSON.parse(match[1])); } catch { /* retain raw benchmark output */ }
        }
      }
    });
    const sample = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, processTreeRss(child.pid)); }, 250);
    sample.unref();
    child.once('exit', (code) => {
      clearInterval(sample);
      resolve({ exitCode: code ?? 1, peakRssBytes, stages });
    });
  });
}
function processTreeRss(rootPid) {
  if (!rootPid || process.platform === 'win32') return 0;
  try {
    const rows = execFileSync('/bin/ps', ['-e', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const byParent = new Map(), rss = new Map();
    for (const line of rows.trim().split('\n')) {
      const [pid, parent, kib] = line.trim().split(/\s+/).map(Number);
      rss.set(pid, kib * 1024); const children = byParent.get(parent) ?? []; children.push(pid); byParent.set(parent, children);
    }
    const pending = [rootPid]; let total = 0;
    while (pending.length) { const pid = pending.pop(); total += rss.get(pid) ?? 0; pending.push(...(byParent.get(pid) ?? [])); }
    return total;
  } catch { return 0; }
}
function median(values) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; }
