/**
 * CLI entry point and top-level orchestration for the Java/JDT-LS knowledge graph.
 * Every persisted observation originates from an LSP response or artifact stage.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import lbug from '@ladybugdb/core';
import {
  ArtifactClasspathResolver,
  retainArtifactClasspathEntries,
} from '../artifact/classpath/index.js';
import { enrichJvmArtifacts } from '../artifact/enrichment.js';
import { dedupeObservationBatch, mergeObservationBatches } from '../ingest/batch.js';
import { openLspLadybugDatabase, type LadybugModuleLike } from '../lbug/repository.js';
import type { LspAnalysisRun } from '../model.js';
import { parseLspKnowledgeGraphBuildOptions } from '../pipeline/cli-options.js';
import { mapConcurrently } from '../pipeline/concurrency.js';
import { crawlJavaBuildRoot } from '../pipeline/java-build-root-crawler.js';
import { findJavaSourceFiles } from '../pipeline/java-source-files.js';
import type { LspKnowledgeGraphBuildOptions, LspKnowledgeGraphBuildResult } from '../pipeline/types.js';
import { ownerBuildRoot, type JavaBuildRoot } from '../../../lsp_server/adapters/java/jdtls-runtime.js';
import { LspAdapterRegistry } from '../../../lsp_server/registry/lsp-adapter-registry.js';

export async function buildLspKnowledgeGraph(
  options: LspKnowledgeGraphBuildOptions,
  adapterRegistry = new LspAdapterRegistry(),
): Promise<LspKnowledgeGraphBuildResult> {
  const workspacePath = path.resolve(options.workspace);
  const javaFiles = findJavaSourceFiles(workspacePath);
  if (javaFiles.length === 0) throw new Error(`No Java files found under ${workspacePath}`);

  const discoveredRoots = adapterRegistry.getJavaBuildRoots(workspacePath);
  const filesByRoot = assignFilesToBuildRoots(javaFiles, discoveredRoots);
  const activeRoots = discoveredRoots.filter((root) => (filesByRoot.get(root.id)?.length ?? 0) > 0);
  if (activeRoots.length === 0) {
    throw new Error('Java files were found but none belongs to a discovered build root');
  }

  console.log(
    `[stage:lsp-crawl] preparing ${activeRoots.length} Java build roots `
    + `(concurrency=${options.concurrency})`,
  );
  const run = createAnalysisRun(workspacePath);
  const artifactClasspathResolver = new ArtifactClasspathResolver();
  let completedRootCount = 0;
  try {
    const rootResults = await mapConcurrently(activeRoots, options.concurrency, async (root) => {
      const files = filesByRoot.get(root.id) ?? [];
      const preparation = await adapterRegistry.prepareJavaBuildRoots(workspacePath, [root.id]);
      const rootPreparation = preparation.roots[0];
      logBuildRootPreparation(preparation.roots);
      console.log(`[${root.id}] starting JDT LS for ${files.length} files`);
      const result = await crawlJavaBuildRoot(
        adapterRegistry,
        artifactClasspathResolver,
        workspacePath,
        run,
        root,
        files,
        rootPreparation,
        options.artifactManifestPaths,
      );
      result.artifacts = retainArtifactClasspathEntries(
        result.artifacts,
        path.join(workspacePath, '.gitnexus', 'jvm-artifacts', 'classpath'),
      );
      completedRootCount += 1;
      console.log(`[${root.id}] complete (${completedRootCount}/${activeRoots.length})`);
      return result;
    });

    finalizeAnalysisRun(run, rootResults);
    const lspBatch = dedupeObservationBatch(mergeObservationBatches(
      ...rootResults.map((result) => result.batch),
    ));
    lspBatch.analysisRuns.splice(0, lspBatch.analysisRuns.length, run);

    console.log('[stage:jvm-artifact-enrichment] associating header, binary, and source JARs');
    const artifactBatch = await enrichJvmArtifacts({
      lspRunId: run.id,
      artifacts: rootResults.flatMap((result) => result.artifacts),
      classpathAttempts: rootResults.flatMap((result) => result.artifactClasspathAttempts),
      cacheDirectory: path.join(workspacePath, '.gitnexus', 'jvm-artifacts'),
      lspBatch,
      maxDisassembledClasses: options.artifactMaxClasses,
      fetchSources: options.fetchArtifactSources,
    });
    logArtifactEnrichment(artifactBatch);

    const outputPath = await persistKnowledgeGraph(options.output, lspBatch, artifactBatch);
    return { batch: lspBatch, artifactBatch, output: outputPath };
  } finally {
    await adapterRegistry.shutdownAll();
  }
}

function assignFilesToBuildRoots(
  javaFiles: string[],
  buildRoots: JavaBuildRoot[],
): Map<string, string[]> {
  const filesByRoot = new Map<string, string[]>();
  for (const file of javaFiles) {
    const root = ownerBuildRoot(file, buildRoots);
    if (!root) continue;
    const rootFiles = filesByRoot.get(root.id) ?? [];
    rootFiles.push(file);
    filesByRoot.set(root.id, rootFiles);
  }
  return filesByRoot;
}

function createAnalysisRun(workspacePath: string): LspAnalysisRun {
  const startedAt = new Date().toISOString();
  return {
    id: `run:${startedAt}:${randomUUID()}`,
    workspaceUri: pathToFileURL(workspacePath).href,
    repositoryPath: workspacePath,
    protocolVersion: '3.18',
    positionEncoding: 'utf-16',
    status: 'partial',
    startedAt,
    requestedLanguages: ['java'],
    errorCount: 0,
    timeoutCount: 0,
  };
}

function finalizeAnalysisRun(
  run: LspAnalysisRun,
  results: Array<{ failed: boolean; errorCount: number; timeoutCount: number }>,
): void {
  run.errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
  run.timeoutCount = results.reduce((sum, result) => sum + result.timeoutCount, 0);
  run.status = results.some((result) => result.failed) || run.errorCount > 0 || run.timeoutCount > 0
    ? 'partial'
    : 'complete';
  run.completedAt = new Date().toISOString();
}

async function persistKnowledgeGraph(
  requestedOutputPath: string,
  lspBatch: LspKnowledgeGraphBuildResult['batch'],
  artifactBatch: LspKnowledgeGraphBuildResult['artifactBatch'],
): Promise<string> {
  const outputPath = path.resolve(requestedOutputPath);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing LSP database: ${outputPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const handle = openLspLadybugDatabase(outputPath, lbug as unknown as LadybugModuleLike);
  try {
    await handle.repository.initializeSchema();
    await handle.repository.writeBatch(lspBatch);
    await handle.artifactRepository.initializeSchema();
    await handle.artifactRepository.writeBatch(artifactBatch);
  } finally {
    await handle.close();
  }
  return outputPath;
}

function logBuildRootPreparation(
  preparations: Array<{ rootId: string; status: string; classpathEntries?: number; reason?: string }>,
): void {
  for (const preparation of preparations) {
    const detail = preparation.classpathEntries !== undefined
      ? `${preparation.classpathEntries} classpath entries`
      : preparation.reason ?? 'no detail';
    console.log(`[${preparation.rootId}] Bazel model ${preparation.status}: ${detail}`);
  }
}

function logArtifactEnrichment(artifactBatch: LspKnowledgeGraphBuildResult['artifactBatch']): void {
  const run = artifactBatch.runs[0];
  const sourceAssociatedArtifacts = artifactBatch.artifacts
    .filter((artifact) => artifact.associationStatus === 'complete').length;
  console.log(
    `[stage:jvm-artifact-enrichment] ${run.status}: ${run.artifactCount} artifacts, `
    + `${run.classCount} classes, ${run.methodCount} methods, ${run.callSiteCount} bytecode calls, `
    + `${sourceAssociatedArtifacts} source-associated artifacts`,
  );
}

async function main(): Promise<void> {
  const options = parseLspKnowledgeGraphBuildOptions(process.argv.slice(2));
  const { batch, artifactBatch, output } = await buildLspKnowledgeGraph(options);
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

if (process.argv[1]?.endsWith('/build.ts') || process.argv[1]?.endsWith('\\build.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
