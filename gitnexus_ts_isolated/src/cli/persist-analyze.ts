/**
 * Write analyze artifacts under `.gitnexus/` (graph.json, manifests, LadybugDB).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PipelineResult } from '../types/pipeline.js';
import type { PipelineStage } from '../ingestion/pipeline-stage.js';
import { writeKnowledgeGraphJson } from '../graph/graph-json.js';
import { initLbug, loadGraphToLbug, wipeLbugDbFiles, closeLbug } from '../lbug/lbug-adapter.js';

export async function persistAnalyzeArtifacts(
  repoPath: string,
  result: PipelineResult,
  options: {
    pipelineStage: PipelineStage;
    lspEnriched: boolean;
  },
): Promise<void> {
  const gitnexusDir = path.join(repoPath, '.gitnexus');
  fs.mkdirSync(gitnexusDir, { recursive: true });

  const indexedAt = new Date().toISOString();
  const stats = {
    files: result.totalFileCount,
    nodes: result.graph.nodeCount,
    edges: result.graph.relationshipCount,
    communities: result.communityResult?.stats.totalCommunities ?? 0,
    processes: result.processResult?.stats.totalProcesses ?? 0,
  };

  const manifest = {
    repoPath,
    indexedAt,
    lspEnriched: options.lspEnriched,
    pipelineStage: options.pipelineStage,
    stats,
  };

  writeKnowledgeGraphJson(repoPath, result.graph, {
    indexedAt,
    lspEnriched: options.lspEnriched,
    pipelineStage: options.pipelineStage,
    stats,
  });

  fs.writeFileSync(path.join(gitnexusDir, 'gitnexus.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const lbugPath = path.join(gitnexusDir, 'lbug');
  await wipeLbugDbFiles(lbugPath);
  await initLbug(lbugPath);
  try {
    await loadGraphToLbug(result.graph, repoPath, gitnexusDir, (msg: string) =>
      console.log(`  [lbug] ${msg}`),
    );
  } finally {
    await closeLbug();
  }

  fs.writeFileSync(
    path.join(gitnexusDir, 'meta.json'),
    JSON.stringify(
      {
        repoPath,
        indexedAt: manifest.indexedAt,
        lspEnriched: manifest.lspEnriched,
        database: {
          type: 'ladybug',
          path: '.gitnexus/lbug',
          schemaVersion: '1.0.0',
        },
        stats: manifest.stats,
      },
      null,
      2,
    ),
    'utf-8',
  );

  if (options.pipelineStage === 'full') {
    try {
      const { execSync } = await import('child_process');
      const rootDir = path.resolve(process.cwd());
      const workflowScript = path.join(rootDir, 'custom_tools', 'workflow_pipeline.py');
      if (fs.existsSync(workflowScript)) {
        execSync(`uv run python "${workflowScript}" "${repoPath}"`, {
          cwd: rootDir,
          stdio: 'pipe',
        });
      }
    } catch {
      // Workflow export is optional; a missing script or failure must not fail analyze.
    }
  }
}
