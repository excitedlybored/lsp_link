/**
 * Set 2: Isolated GitNexus Analyzer with LSP Precision Integration.
 *
 * Runs the full 17-phase GitNexus pipeline + LSP Enrichment Phase,
 * connecting to the live Language Server to produce compiler-verified .gitnexus graphs.
 */

import * as path from 'path';
import * as fs from 'fs';
import { runPipelineFromRepo } from '../ingestion/pipeline.js';
import { PipelineProgress } from '../shared/pipeline.js';

async function main() {
  const targetProject = process.argv[2] || 'sample_projects/spring-boot-demo';
  const resolvedRepoPath = path.resolve(process.cwd(), targetProject);

  console.log(`========================================================================`);
  console.log(`⚡ GitNexus Isolated Analyzer (with Live LSP Compiler Integration)`);
  console.log(`   Target Project: ${resolvedRepoPath}`);
  console.log(`========================================================================\n`);

  if (!fs.existsSync(resolvedRepoPath)) {
    console.error(`❌ Target project directory '${resolvedRepoPath}' does not exist.`);
    process.exit(1);
  }

  const startTime = Date.now();

  const progressCallback = (p: PipelineProgress) => {
    const percentStr = String(p.percent).padStart(3, ' ');
    console.log(`[${percentStr}%] [Phase: ${p.phase.padEnd(16)}] ${p.message}`);
  };

  try {
    const result = await runPipelineFromRepo(resolvedRepoPath, progressCallback, {
      lsp: true,
      skipGraphPhases: false,
    });

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n========================================================================`);
    console.log(`✓ Repository Indexed Successfully in ${durationSec}s!`);
    console.log(`========================================================================`);
    console.log(`📊 Knowledge Graph Metrics:`);
    console.log(`   • Total Files Processed: ${result.totalFileCount}`);
    console.log(`   • Graph Nodes:          ${result.graph.nodeCount}`);
    console.log(`   • Graph Relationships:  ${result.graph.relationshipCount}`);

    if (result.communityResult) {
      console.log(`   • Communities/Clusters: ${result.communityResult.stats.totalCommunities}`);
    }
    if (result.processResult) {
      console.log(`   • Business Processes:   ${result.processResult.stats.totalProcesses}`);
    }

    // Persist manifest to target .gitnexus/
    const gitnexusDir = path.join(resolvedRepoPath, '.gitnexus');
    fs.mkdirSync(gitnexusDir, { recursive: true });

    const manifest = {
      repoPath: resolvedRepoPath,
      indexedAt: new Date().toISOString(),
      lspEnriched: true,
      stats: {
        files: result.totalFileCount,
        nodes: result.graph.nodeCount,
        edges: result.graph.relationshipCount,
        communities: result.communityResult?.stats.totalCommunities ?? 0,
        processes: result.processResult?.stats.totalProcesses ?? 0,
      },
    };

    fs.writeFileSync(path.join(gitnexusDir, 'gitnexus.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`\n💾 Saved LSP-enriched manifest to: ${path.join(gitnexusDir, 'gitnexus.json')}\n`);
  } catch (err: any) {
    console.error(`\n❌ Ingestion failed:`, err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
