/**
 * Complete Java/JDT-LS crawl into the isolated LSP-native LadybugDB schema.
 *
 * Build-root concurrency is bounded (default 4). Each root owns an independent
 * JDT LS process and the crawler serializes requests inside that process.
 * Tree-sitter and the legacy GitNexus graph are not read at any point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import lbug from '@ladybugdb/core';
import { LspAdapterRegistry } from './registry/lsp-adapter-registry.js';
import { JdtlsWorkspace, ownerBuildRoot, type JavaBuildRoot } from './adapters/java/jdtls-runtime.js';
import {
  crawlLspBuildRoot,
  workspaceDocument,
} from '../lsp_kg_isolated/src/ingest/crawler.js';
import {
  dedupeObservationBatch,
  emptyObservationBatch,
  mergeObservationBatches,
  type LspObservationBatch,
} from '../lsp_kg_isolated/src/ingest/batch.js';
import { ingestRun } from '../lsp_kg_isolated/src/ingest/builders.js';
import { collectCapabilities, withCompleteCapabilityCoverage } from '../lsp_kg_isolated/src/ingest/collector.js';
import type {
  LspAnalysisRun,
  LspBuildRoot,
  LspServer,
} from '../lsp_kg_isolated/src/model.js';
import {
  openLspLadybugDatabase,
  type LadybugModuleLike,
} from '../lsp_kg_isolated/src/lbug/repository.js';
import { crawlJvmArtifacts } from '../lsp_kg_isolated/src/artifact/crawler.js';
import type { JvmArtifactBatch } from '../lsp_kg_isolated/src/artifact/model.js';
import {
  ArtifactClasspathProviderRegistry,
  type ArtifactClasspathProviderAttempt,
  type NormalizedArtifactDescriptor,
} from '../lsp_kg_isolated/src/artifact/classpath-provider.js';

interface CliOptions {
  workspace: string;
  output: string;
  concurrency: number;
  artifactMaxClasses?: number;
  fetchArtifactSources: boolean;
  artifactManifestPaths: string[];
}

interface RootResult {
  batch: LspObservationBatch;
  artifacts: NormalizedArtifactDescriptor[];
  artifactClasspathAttempts: ArtifactClasspathProviderAttempt[];
  failed: boolean;
  errorCount: number;
  timeoutCount: number;
}

export async function buildCompleteLspKnowledgeGraph(
  options: CliOptions,
  registry = new LspAdapterRegistry(),
): Promise<{ batch: LspObservationBatch; artifactBatch: JvmArtifactBatch; output: string }> {
  const workspace = path.resolve(options.workspace);
  const javaFiles = collectJavaFiles(workspace);
  if (javaFiles.length === 0) throw new Error(`No Java files found under ${workspace}`);

  const roots = registry.getJavaBuildRoots(workspace);
  const filesByRoot = new Map<string, string[]>();
  for (const file of javaFiles) {
    const root = ownerBuildRoot(file, roots);
    if (!root) continue;
    const values = filesByRoot.get(root.id) ?? [];
    values.push(file);
    filesByRoot.set(root.id, values);
  }
  const activeRoots = roots.filter((root) => (filesByRoot.get(root.id)?.length ?? 0) > 0);
  if (activeRoots.length === 0) throw new Error('Java files were found but none belongs to a discovered build root');

  console.log(`[stage:lsp-crawl] preparing ${activeRoots.length} Java build roots (concurrency=${options.concurrency})`);
  const preparation = await registry.prepareJavaBuildRoots(workspace, activeRoots.map((root) => root.id));
  const preparationByRoot = new Map(preparation.roots.map((value) => [value.rootId, value]));
  for (const value of preparation.roots) {
    const detail = value.classpathEntries !== undefined
      ? `${value.classpathEntries} classpath entries`
      : value.reason ?? 'no detail';
    console.log(`[${value.rootId}] Bazel model ${value.status}: ${detail}`);
  }

  const startedAt = new Date().toISOString();
  const artifactProviders = new ArtifactClasspathProviderRegistry();
  const run: LspAnalysisRun = {
    id: `run:${startedAt}:${randomUUID()}`,
    workspaceUri: pathToFileURL(workspace).href,
    repositoryPath: workspace,
    protocolVersion: '3.18',
    positionEncoding: 'utf-16',
    status: 'partial',
    startedAt,
    requestedLanguages: ['java'],
    errorCount: 0,
    timeoutCount: 0,
  };

  let completedRoots = 0;
  try {
    const results = await mapWithConcurrency(activeRoots, options.concurrency, async (root) => {
      const files = filesByRoot.get(root.id) ?? [];
      console.log(`[${root.id}] starting JDT LS for ${files.length} files`);
      const result = await crawlRoot(
        registry, artifactProviders, workspace, run, root, files, preparationByRoot.get(root.id),
        options.artifactManifestPaths,
      );
      completedRoots += 1;
      console.log(`[${root.id}] complete (${completedRoots}/${activeRoots.length})`);
      return result;
    });

    run.errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
    run.timeoutCount = results.reduce((sum, result) => sum + result.timeoutCount, 0);
    run.status = results.some((result) => result.failed) || run.errorCount > 0 || run.timeoutCount > 0
      ? 'partial'
      : 'complete';
    run.completedAt = new Date().toISOString();

    const merged = dedupeObservationBatch(mergeObservationBatches(...results.map((result) => result.batch)));
    merged.analysisRuns.splice(0, merged.analysisRuns.length, run);
    console.log('[stage:jvm-artifact-enrichment] associating header, binary, and source JARs');
    const artifactBatch = await crawlJvmArtifacts({
      lspRunId: run.id,
      artifacts: results.flatMap((value) => value.artifacts),
      classpathAttempts: results.flatMap((value) => value.artifactClasspathAttempts),
      cacheDirectory: path.join(workspace, '.gitnexus', 'jvm-artifacts'),
      lspBatch: merged,
      maxDisassembledClasses: options.artifactMaxClasses,
      fetchSources: options.fetchArtifactSources,
    });
    const artifactRun = artifactBatch.runs[0];
    const completeArtifacts = artifactBatch.artifacts.filter((value) => value.associationStatus === 'complete').length;
    console.log(`[stage:jvm-artifact-enrichment] ${artifactRun.status}: ` +
      `${artifactRun.artifactCount} artifacts, ${artifactRun.classCount} classes, ` +
      `${artifactRun.methodCount} methods, ${artifactRun.callSiteCount} bytecode calls, ` +
      `${completeArtifacts} source-associated artifacts`);
    const output = path.resolve(options.output);
    if (fs.existsSync(output)) {
      throw new Error(`Refusing to overwrite existing LSP database: ${output}`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const handle = openLspLadybugDatabase(output, lbug as unknown as LadybugModuleLike);
    try {
      await handle.repository.initializeSchema();
      await handle.repository.writeBatch(merged);
      await handle.artifactRepository.initializeSchema();
      await handle.artifactRepository.writeBatch(artifactBatch);
    } finally {
      await handle.close();
    }
    return { batch: merged, artifactBatch, output };
  } finally {
    await registry.shutdownAll();
  }
}

async function crawlRoot(
  registry: LspAdapterRegistry,
  artifactProviders: ArtifactClasspathProviderRegistry,
  repositoryPath: string,
  run: LspAnalysisRun,
  root: JavaBuildRoot,
  files: string[],
  preparation?: { status: string; configurationHash?: string; reason?: string; modelPath?: string },
  artifactManifestPaths: string[] = [],
): Promise<RootResult> {
  const buildRoot: LspBuildRoot = {
    id: root.id,
    runId: run.id,
    workspaceUri: pathToFileURL(root.workspacePath).href,
    repositoryPath: root.workspacePath,
    relativePath: root.relativePath,
    buildSystems: root.systems,
    javaMajor: JdtlsWorkspace.inspect(root.workspacePath, {
      buildSystems: root.systems,
      excludedRoots: root.excludedRoots,
    }).requiredJavaMajor,
    importStatus: preparation?.status === 'failed'
      ? 'failed'
      : preparation?.status === 'disabled'
        ? 'disabled'
        : 'ready',
    configurationHash: preparation?.configurationHash,
    excludedRootIds: root.excludedRoots,
  };
  const server: LspServer = {
    id: `server:${run.id}:${root.id}`,
    runId: run.id,
    name: 'jdtls',
    languageId: 'java',
    status: 'partial',
    capabilitiesJson: '{}',
    buildRootId: root.id,
  };
  const documents = files.map((file) => workspaceDocument(file, root.id));
  if (root.systems.includes('bazel') && preparation?.status === 'failed') {
    server.status = 'failed';
    console.warn(`[${root.id}] refusing semantic crawl without Bazel classpath: ${preparation.reason}`);
    const base = ingestRun(run, [server], documents, [buildRoot]);
    const coverage = await collectCapabilities(
      { runId: run.id, serverId: server.id },
      withCompleteCapabilityCoverage([], 'java'),
    );
    const artifactResolution = await artifactProviders.resolve({
      root, documentUris: documents.map((value) => value.uri), bazelModelPath: preparation?.modelPath,
      manifestPaths: artifactManifestPaths,
    });
    return {
      batch: mergeObservationBatches(base, coverage),
      artifacts: artifactResolution.artifacts,
      artifactClasspathAttempts: artifactResolution.attempts,
      failed: true,
      errorCount: 1,
      timeoutCount: 0,
    };
  }
  const adapter = await registry.getOrStartJavaBuildRoot(root);
  if (!adapter) {
    server.status = 'failed';
    const base = ingestRun(run, [server], documents, [buildRoot]);
    const coverage = await collectCapabilities(
      { runId: run.id, serverId: server.id },
      withCompleteCapabilityCoverage([], 'java'),
    );
    const artifactResolution = await artifactProviders.resolve({
      root, documentUris: documents.map((value) => value.uri), bazelModelPath: preparation?.modelPath,
      manifestPaths: artifactManifestPaths,
    });
    return {
      batch: mergeObservationBatches(base, coverage),
      artifacts: artifactResolution.artifacts,
      artifactClasspathAttempts: artifactResolution.attempts,
      failed: true, errorCount: 1, timeoutCount: 0,
    };
  }

  const serverCapabilities = adapter.getServerCapabilities();
  const serverInfo = serverCapabilities.__serverInfo as { name?: string; version?: string } | undefined;
  server.name = serverInfo?.name ?? server.name;
  server.version = serverInfo?.version;
  server.capabilitiesJson = JSON.stringify(serverCapabilities);
  try {
    const batch = await crawlLspBuildRoot({
      run, server, buildRoot, documents, adapter, repositoryPath,
    });
    const artifactResolution = await artifactProviders.resolve({
      root, adapter, documentUris: documents.map((value) => value.uri),
      bazelModelPath: preparation?.modelPath, manifestPaths: artifactManifestPaths,
    });
    const artifacts = artifactResolution.artifacts;
    const providers = [...new Set(artifacts.flatMap((value) => value.providerIds))];
    console.log(`[${root.id}] artifact classpath: ${artifacts.length} JARs via ${providers.join(', ') || 'none'}`);
    const failures = batch.coverage.reduce((sum, value) => sum + value.failureCount, 0);
    const timeouts = batch.coverage.reduce((sum, value) => sum + value.timeoutCount, 0);
    server.status = failures > 0 || timeouts > 0 ? 'partial' : 'complete';
    return {
      batch, artifacts, artifactClasspathAttempts: artifactResolution.attempts,
      failed: false, errorCount: failures, timeoutCount: timeouts,
    };
  } catch (error) {
    server.status = 'failed';
    console.warn(`[${root.id}] crawl failed: ${error instanceof Error ? error.message : String(error)}`);
    const artifactResolution = await artifactProviders.resolve({
      root, adapter, documentUris: documents.map((value) => value.uri),
      bazelModelPath: preparation?.modelPath, manifestPaths: artifactManifestPaths,
    });
    return {
      batch: ingestRun(run, [server], documents, [buildRoot]),
      artifacts: artifactResolution.artifacts,
      artifactClasspathAttempts: artifactResolution.attempts,
      failed: true,
      errorCount: 1,
      timeoutCount: error instanceof Error && /timeout|timed out/i.test(error.message) ? 1 : 0,
    };
  } finally {
    await registry.shutdownAdapter(adapter);
  }
}

function collectJavaFiles(workspace: string): string[] {
  return globSync('**/*.java', {
    cwd: workspace,
    absolute: true,
    ignore: [
      '**/.git/**', '**/.gitnexus/**', '**/node_modules/**', '**/target/**', '**/build/**',
      '**/bazel-bin/**', '**/bazel-out/**', '**/bazel-testlogs/**',
    ],
  }).sort();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  execute: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await execute(items[index]);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker(),
  ));
  return results;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  if (args[0] === 'build') args.shift();
  const workspace = path.resolve(args.shift() ?? '.');
  let output = path.join(workspace, '.gitnexus', 'lsp-lbug');
  let concurrency = 4;
  let artifactMaxClasses: number | undefined;
  let fetchArtifactSources = true;
  const artifactManifestPaths: string[] = [];
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') output = path.resolve(args.shift() ?? '');
    else if (flag === '--concurrency') concurrency = Number(args.shift());
    else if (flag === '--artifact-max-classes') artifactMaxClasses = Number(args.shift());
    else if (flag === '--no-artifact-source-fetch') fetchArtifactSources = false;
    else if (flag === '--artifact-classpath-manifest') artifactManifestPaths.push(path.resolve(args.shift() ?? ''));
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${concurrency}`);
  }
  if (artifactMaxClasses !== undefined && (!Number.isInteger(artifactMaxClasses) || artifactMaxClasses < 1)) {
    throw new Error(`--artifact-max-classes must be a positive integer, got ${artifactMaxClasses}`);
  }
  return {
    workspace, output, concurrency, artifactMaxClasses, fetchArtifactSources, artifactManifestPaths,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { batch, artifactBatch, output } = await buildCompleteLspKnowledgeGraph(options);
  console.log(JSON.stringify({
    output,
    run: batch.analysisRuns[0],
    buildRoots: batch.buildRoots.length,
    servers: batch.servers.length,
    documents: batch.documents.length,
    symbols: batch.symbols.length,
    callSites: batch.callSites.length,
    occurrences: batch.occurrences.length,
    diagnostics: batch.diagnostics.length,
    semanticTokens: batch.semanticTokens.length,
    coverage: batch.coverage.length,
    relations: batch.relations.length,
    artifactEnrichment: artifactBatch.runs[0],
  }, null, 2));
}

if (process.argv[1]?.includes('build-lsp-kg')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
