import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { globSync } from 'glob';
import lbug from '@ladybugdb/core';
import { openLspLadybugDatabase } from '../indexer/dist/lbug/repository.js';
import { streamJvmArtifacts } from '../indexer/dist/artifact/streaming-enrichment.js';
import { ArtifactBulkSpoolSink, bulkCopyArtifactGraph } from '../indexer/dist/artifact/bulk-copy.js';

const options = parseArguments(process.argv.slice(2));
const SCALING_GATE_MAX_RATIO = 3;
process.env.GITNEXUS_LBUG_BUFFER_POOL_MB ??= '1024';
if (options.gate) {
  const small = await benchmark({ ...options, classes: 25_000, output: undefined });
  const large = await benchmark({ ...options, classes: 100_000, output: undefined });
  const ratio = large.peakRssBytes / small.peakRssBytes;
  const result = {
    small, large, peakRssRatio: ratio,
    scalingGateMaxRatio: SCALING_GATE_MAX_RATIO,
    scalingGatePassed: ratio < SCALING_GATE_MAX_RATIO,
  };
  console.log(JSON.stringify(result, null, 2));
  if (ratio >= SCALING_GATE_MAX_RATIO) process.exitCode = 1;
} else {
  const result = await benchmark(options);
  console.log(JSON.stringify(result, null, 2));
  if (options.baselineRssMb && result.peakRssBytes > options.baselineRssMb * 1024 * 1024 * 0.5) {
    console.error(`Peak RSS did not improve by 50% from ${options.baselineRssMb} MiB baseline.`);
    process.exitCode = 1;
  }
}

async function benchmark(configuration) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-asm-benchmark-'));
  const output = path.resolve(configuration.output ?? path.join(temporary, 'benchmark.lbug'));
  try {
    const jars = configuration.jars.length > 0
      ? configuration.jars.map((value) => path.resolve(value))
      : [generateSyntheticJar(temporary, configuration.classes)];
    let handle = openLspLadybugDatabase(output, lbug);
    await handle.repository.initializeSchema();
    await handle.artifactRepository.initializeSchema();
    let batches = 0;
    let peakRssBytes = sampleProcessTree().rssBytes;
    let peakCpuMs = 0;
    const sample = () => {
      const usage = sampleProcessTree();
      peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
      peakCpuMs = Math.max(peakCpuMs, usage.cpuMs);
    };
    const sampler = setInterval(sample, 25);
    sampler.unref();
    const bulkSink = new ArtifactBulkSpoolSink(path.join(temporary, 'artifact-spool'), async (
      initialization, finalBatch, spoolFiles, run,
    ) => {
      sample();
      await bulkCopyArtifactGraph(
        handle.artifactRepository.connectionForBulkCopy(), initialization, finalBatch,
        spoolFiles, run, path.join(temporary, 'copy-work'), async () => {
          await handle.close();
          handle = openLspLadybugDatabase(output, lbug);
          sample();
          return handle.artifactRepository.connectionForBulkCopy();
        },
      );
      sample();
    });
    const sink = {
      initialize: (...args) => bulkSink.initialize(...args),
      write: async (...args) => { batches++; sample(); await bulkSink.write(...args); sample(); },
      completeArtifact: (...args) => bulkSink.completeArtifact(...args),
      resolveClassArtifacts: (...args) => bulkSink.resolveClassArtifacts(...args),
      finalize: (...args) => bulkSink.finalize(...args),
    };
    const lspBatch = {
      analysisRuns: [], servers: [], buildRoots: [], documents: [], symbols: [], callSites: [],
      occurrences: [], hovers: [], diagnostics: [], semanticTokens: [], signatureHelps: [],
      signatures: [], parameters: [], coverage: [], evidence: [], relations: [],
    };
    const started = process.hrtime.bigint();
    const summary = await streamJvmArtifacts({
      lspRunId: `benchmark:${configuration.classes}`, cacheDirectory: temporary,
      artifacts: jars.map((jar, classpathOrdinal) => ({
        buildRootId: 'benchmark', providerIds: ['explicit-manifest'], scope: 'compile',
        modulePath: false, classpathEntryPath: jar, binaryJarPath: jar,
        coordinate: `benchmark:artifact-${classpathOrdinal}:1`,
      })),
      lspBatch, workerConcurrency: configuration.concurrency, fetchSources: false,
    }, sink);
    clearInterval(sampler);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    sample();
    if (configuration.trace) console.error('[benchmark] closing database');
    await handle.close();
    if (configuration.trace) console.error('[benchmark] database closed');
    return {
      requestedSyntheticClasses: configuration.jars.length > 0 ? null : configuration.classes,
      classCount: summary.run.classCount,
      methodCount: summary.run.methodCount,
      fieldCount: summary.run.fieldCount,
      callSiteCount: summary.run.callSiteCount,
      artifactCount: summary.run.artifactCount,
      batchCount: batches,
      wallMs: Math.round(wallMs),
      cpuMs: Math.round(peakCpuMs),
      throughputClassesPerSecond: Math.round(summary.run.classCount / (wallMs / 1000)),
      peakRssBytes,
      databaseBytes: fs.statSync(output).size,
      output: configuration.output ? output : null,
    };
  } finally {
    if (!configuration.output) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function generateSyntheticJar(directory, classes) {
  if (!Number.isInteger(classes) || classes < 1 || classes > 100_000) {
    throw new Error(`--classes must be an integer from 1 to 100000, got ${classes}`);
  }
  const sourceRoot = path.join(directory, 'source/bench');
  const classRoot = path.join(directory, 'classes');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const source = path.join(sourceRoot, 'Synthetic000000.java');
  fs.writeFileSync(source, [
    'package bench;',
    'public interface Synthetic000000 {}',
  ].join('\n'));
  execFileSync(jdkTool('javac'), ['--release', '21', '-d', classRoot, source]);
  const baseClass = path.join(classRoot, 'bench/Synthetic000000.class');
  const jar = path.join(directory, `synthetic-${classes}.jar`);
  const python = [
    'import sys, zipfile',
    'base, output, count = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    "needle = b'bench/Synthetic000000'",
    'data = open(base, "rb").read()',
    'with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:',
    '  for index in range(count):',
    '    name = f"bench/Synthetic{index:06d}"',
    '    replacement = name.encode()',
    '    assert len(replacement) == len(needle)',
    '    archive.writestr(name + ".class", data.replace(needle, replacement))',
  ].join('\n');
  execFileSync('python3', ['-c', python, baseClass, jar, String(classes)]);
  return jar;
}

function sampleProcessTree() {
  let rssBytes = process.memoryUsage().rss;
  let cpuMs = (process.cpuUsage().user + process.cpuUsage().system) / 1000;
  if (process.platform !== 'linux') return { rssBytes, cpuMs };
  const descendants = new Set([process.pid]);
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      rows.push({ pid: Number(entry), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]) });
    } catch { /* process exited while sampling */ }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
      descendants.add(row.pid); changed = true;
    }
  }
  const clockTicks = 100;
  for (const row of rows) {
    if (row.pid === process.pid || !descendants.has(row.pid)) continue;
    try {
      const pages = Number(fs.readFileSync(`/proc/${row.pid}/statm`, 'utf8').split(' ')[1]);
      rssBytes += pages * 4096;
      cpuMs += row.ticks * 1000 / clockTicks;
    } catch { /* process exited while sampling */ }
  }
  return { rssBytes, cpuMs };
}

function jdkTool(name) {
  const home = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
  if (home) return path.join(home, 'bin', name);
  return [
    ...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(path.join(os.homedir(), `.local/jdks/*/bin/${name}`)),
  ][0] ?? name;
}

function parseArguments(args) {
  const result = { classes: 25_000, concurrency: 4, jars: [], gate: false };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--classes') result.classes = Number(args.shift());
    else if (flag === '--concurrency') result.concurrency = Number(args.shift());
    else if (flag === '--output') result.output = args.shift();
    else if (flag === '--jar') result.jars.push(args.shift());
    else if (flag === '--baseline-rss-mb') result.baselineRssMb = Number(args.shift());
    else if (flag === '--gate') result.gate = true;
    else if (flag === '--trace') result.trace = true;
    else throw new Error(`Unknown benchmark argument ${flag}`);
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 16) {
    throw new Error(`--concurrency must be an integer from 1 to 16, got ${result.concurrency}`);
  }
  return result;
}
