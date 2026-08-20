/**
 * Custom Side-by-Side AST vs. LSP Graph Comparator.
 *
 * Runs AST-only ingestion vs. Live LSP ingestion and computes the exact
 * compiler edge delta and structural differences.
 */

import * as path from 'path';
import * as fs from 'fs';
import { runPipelineFromRepo } from '../gitnexus_ts_isolated/src/ingestion/pipeline.js';

async function main() {
  const targetProject = process.argv[2] || 'sample_projects/spring-boot-demo';
  const resolvedRepoPath = path.resolve(process.cwd(), targetProject);
  const gitnexusDir = path.join(resolvedRepoPath, '.gitnexus');
  fs.mkdirSync(gitnexusDir, { recursive: true });

  console.log(`========================================================================`);
  console.log(`🔬 CUSTOM SIDE-BY-SIDE GRAPH COMPARISON TOOL`);
  console.log(`   Project: ${resolvedRepoPath}`);
  console.log(`========================================================================\n`);

  // 1. Run Standard GitNexus (Tree-sitter AST only)
  console.log(`▶ [1/2] Running Standard AST Ingestion (--no-lsp)...`);
  const t0 = Date.now();
  const standardResult = await runPipelineFromRepo(resolvedRepoPath, () => {}, {
    lsp: false,
    skipGraphPhases: false,
  });
  const tStandard = ((Date.now() - t0) / 1000).toFixed(1);

  // 2. Run LSP-Enriched GitNexus
  console.log(`▶ [2/2] Running Live LSP Precision Ingestion (Default)...`);
  const t1 = Date.now();
  const lspResult = await runPipelineFromRepo(resolvedRepoPath, () => {}, {
    lsp: true,
    skipGraphPhases: false,
  });
  const tLsp = ((Date.now() - t1) / 1000).toFixed(1);

  console.log(`\n========================================================================`);
  console.log(`📊 Graph Comparison Summary`);
  console.log(`========================================================================`);
  console.log(`| Metric                | Standard AST | LSP-Enriched | Delta     |`);
  console.log(`|-----------------------|--------------|--------------|-----------|`);
  console.log(`| Total Nodes           | ${String(standardResult.graph.nodeCount).padEnd(12)} | ${String(lspResult.graph.nodeCount).padEnd(12)} | ${String(lspResult.graph.nodeCount - standardResult.graph.nodeCount).padEnd(9)} |`);
  console.log(`| Total Edges           | ${String(standardResult.graph.relationshipCount).padEnd(12)} | ${String(lspResult.graph.relationshipCount).padEnd(12)} | +${String(lspResult.graph.relationshipCount - standardResult.graph.relationshipCount).padEnd(8)} |`);
  console.log(`| Ingestion Time        | ${tStandard}s          | ${tLsp}s          |           |`);
  console.log(`========================================================================\n`);
}

main().catch((err) => {
  console.error('Error running comparison:', err);
  process.exit(1);
});
