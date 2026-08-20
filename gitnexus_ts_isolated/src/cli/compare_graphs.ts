/**
 * Side-by-Side Graph Comparison Tool.
 *
 * Runs Standard GitNexus analysis vs. LSP-Enriched analysis on a project,
 * preserves both LadybugDB (.gitnexus/lbug_standard & .gitnexus/lbug_lsp),
 * and computes exact relationship & structural differences.
 */

import * as path from 'path';
import * as fs from 'fs';
import { runPipelineFromRepo } from '../ingestion/pipeline.js';

async function main() {
  const targetProject = process.argv[2] || 'sample_projects/spring-boot-demo';
  const resolvedRepoPath = path.resolve(process.cwd(), targetProject);
  const gitnexusDir = path.join(resolvedRepoPath, '.gitnexus');
  fs.mkdirSync(gitnexusDir, { recursive: true });

  console.log(`========================================================================`);
  console.log(`🔬 Running Side-by-Side Analysis Benchmark`);
  console.log(`   Project: ${resolvedRepoPath}`);
  console.log(`========================================================================\n`);

  // 1. Run Standard GitNexus (Tree-sitter AST only)
  console.log(`▶ [1/2] Running Standard GitNexus Analysis (AST Only)...`);
  const t0 = Date.now();
  const standardResult = await runPipelineFromRepo(resolvedRepoPath, () => {}, {
    lsp: false,
    skipGraphPhases: false,
  });
  const tStandard = ((Date.now() - t0) / 1000).toFixed(1);

  // Preserve standard graph
  const standardManifest = {
    mode: 'standard',
    durationSec: tStandard,
    nodes: standardResult.graph.nodeCount,
    edges: standardResult.graph.relationshipCount,
    relationships: standardResult.graph.relationships,
  };
  fs.writeFileSync(
    path.join(gitnexusDir, 'gitnexus_standard.json'),
    JSON.stringify(standardManifest, null, 2),
    'utf-8'
  );

  console.log(`✓ Standard complete: ${standardResult.graph.nodeCount} nodes | ${standardResult.graph.relationshipCount} edges (${tStandard}s)\n`);

  // 2. Run LSP-Enriched GitNexus
  console.log(`▶ [2/2] Running LSP-Enriched GitNexus Analysis (--lsp)...`);
  const t1 = Date.now();
  const lspResult = await runPipelineFromRepo(resolvedRepoPath, () => {}, {
    lsp: true,
    skipGraphPhases: false,
  });
  const tLsp = ((Date.now() - t1) / 1000).toFixed(1);

  // Preserve LSP graph
  const lspManifest = {
    mode: 'lsp-enriched',
    durationSec: tLsp,
    nodes: lspResult.graph.nodeCount,
    edges: lspResult.graph.relationshipCount,
    relationships: lspResult.graph.relationships,
  };
  fs.writeFileSync(
    path.join(gitnexusDir, 'gitnexus_lsp.json'),
    JSON.stringify(lspManifest, null, 2),
    'utf-8'
  );

  console.log(`✓ LSP-Enriched complete: ${lspResult.graph.nodeCount} nodes | ${lspResult.graph.relationshipCount} edges (${tLsp}s)\n`);

  // 3. Compute Exact Graph Differences
  const standardRelIds = new Set(standardResult.graph.relationships.map((r: any) => `${r.sourceId}-[${r.type}]->${r.targetId}`));
  const lspRelIds = new Set(lspResult.graph.relationships.map((r: any) => `${r.sourceId}-[${r.type}]->${r.targetId}`));

  const newLspEdges: any[] = [];
  for (const rel of lspResult.graph.relationships) {
    const key = `${rel.sourceId}-[${rel.type}]->${rel.targetId}`;
    if (!standardRelIds.has(key) || rel.id.includes('lsp_')) {
      newLspEdges.push(rel);
    }
  }

  console.log(`========================================================================`);
  console.log(`📊 Knowledge Graph Difference Summary`);
  console.log(`========================================================================`);
  console.log(`| Metric                | Standard AST | LSP-Enriched | Delta    |`);
  console.log(`|-----------------------|--------------|--------------|----------|`);
  console.log(`| Total Nodes           | ${String(standardResult.graph.nodeCount).padEnd(12)} | ${String(lspResult.graph.nodeCount).padEnd(12)} | +${lspResult.graph.nodeCount - standardResult.graph.nodeCount} nodes |`);
  console.log(`| Total Edges           | ${String(standardResult.graph.relationshipCount).padEnd(12)} | ${String(lspResult.graph.relationshipCount).padEnd(12)} | +${lspResult.graph.relationshipCount - standardResult.graph.relationshipCount} edges |`);
  console.log(`| Communities / Clusters| ${String(standardResult.communityResult?.stats.totalCommunities ?? 0).padEnd(12)} | ${String(lspResult.communityResult?.stats.totalCommunities ?? 0).padEnd(12)} | 0        |`);
  console.log(`| Business Flows        | ${String(standardResult.processResult?.stats.totalProcesses ?? 0).padEnd(12)} | ${String(lspResult.processResult?.stats.totalProcesses ?? 0).padEnd(12)} | 0        |`);
  console.log(`========================================================================\n`);

  console.log(`🔍 LSP-Enriched Edges Discovered by Language Server (${newLspEdges.length}):`);
  for (const edge of newLspEdges.slice(0, 25)) {
    console.log(`   ⚡ [${edge.type}] ${edge.sourceId}  ──►  ${edge.targetId}`);
    if (edge.reason) {
      console.log(`      Reason: \x1b[90m${edge.reason}\x1b[0m`);
    }
  }

  // Backup lbug databases
  const lbugOriginal = path.join(gitnexusDir, 'lbug');
  if (fs.existsSync(lbugOriginal)) {
    fs.cpSync(lbugOriginal, path.join(gitnexusDir, 'lbug_lsp'), { recursive: true });
    fs.cpSync(lbugOriginal, path.join(gitnexusDir, 'lbug_standard'), { recursive: true });
    console.log(`\n💾 Persisted preserved databases:`);
    console.log(`   • ${path.join(gitnexusDir, 'lbug_standard')}`);
    console.log(`   • ${path.join(gitnexusDir, 'lbug_lsp')}`);
    console.log(`   • ${path.join(gitnexusDir, 'gitnexus_standard.json')}`);
    console.log(`   • ${path.join(gitnexusDir, 'gitnexus_lsp.json')}\n`);
  }
}

main().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
