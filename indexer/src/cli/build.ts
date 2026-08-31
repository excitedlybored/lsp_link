/** Thin CLI shell for the Java knowledge-graph pipeline. */

import { buildLspKnowledgeGraph, crawlLspRepository } from '../application/index-runner.js';
import { parseLspKnowledgeGraphBuildOptions } from '../pipeline/cli-options.js';
import { runBazelPreparationCommand } from './bazel-prepare.js';

export { buildLspKnowledgeGraph } from '../application/index-runner.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === '--help' || command === '-h') {
    console.log('Usage: npm run index -- <prepare-build-model|crawl|build-index> REPOSITORY [options]');
    return;
  }
  if (command === 'prepare-build-model' || command === 'bazel-prepare') {
    await runBazelPreparationCommand(process.argv.slice(3));
    return;
  }
  const options = parseLspKnowledgeGraphBuildOptions(process.argv.slice(2));
  if (command === 'crawl') {
    const result = await crawlLspRepository(options);
    console.log(JSON.stringify({
      mode: 'crawl-only',
      checkpoint: result.checkpoint,
      crawlFingerprint: result.crawlFingerprint,
      durationMs: result.durationMs,
      peakNodeRssMiB: result.peakNodeRssMiB,
      crawlProfile: options.crawlProfile,
      javaSemantics: options.javaSemantics,
      jdtProcesses: options.jdtProcesses,
      documents: result.batch.documents.length,
      symbols: result.batch.symbols.length,
      occurrences: result.batch.occurrences.length,
      callSites: result.batch.callSites.length,
      relations: result.batch.relations.length,
      artifacts: result.artifacts.length,
    }, null, 2));
    return;
  }
  const { batch, callNormalizationBatch, artifactEnrichment, bazelBuildGraph, output } =
    await buildLspKnowledgeGraph(options);
  console.log(JSON.stringify({
    output,
    crawlProfile: options.crawlProfile,
    javaSemantics: options.javaSemantics,
    crawlStrategy: 'efficient-facts-first',
    crawlCacheId: batch.analysisRuns[0]?.id.replace(/^run:/, ''),
    buildModelMode: options.bazelBuildMode === 'prebuilt' ? 'prepared' : 'integrated',
    bazelTargetQuery: options.bazelTargetQuery,
    runConfigPath: options.runConfigPath,
    runConfigHash: options.runConfigHash,
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
    callNormalization: callNormalizationBatch.runs[0],
    artifactEnrichment: artifactEnrichment.run,
    bazelBuildGraph: {
      roots: bazelBuildGraph.runs.length,
      targets: bazelBuildGraph.targets.length,
      sources: bazelBuildGraph.sources.length,
      artifacts: bazelBuildGraph.artifacts.length,
      relations: bazelBuildGraph.relations.length,
    },
  }, null, 2));
}

if (process.argv[1]?.endsWith('/build.ts') || process.argv[1]?.endsWith('\\build.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
