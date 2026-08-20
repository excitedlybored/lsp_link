/**
 * Custom Business Flows & Entry/Exit Points Inspector.
 *
 * Traverses the compiler-verified Knowledge Graph and extracts:
 * - Entry Points (REST Controllers, API Handlers, CLI Handlers, Main entry points)
 * - Exit Points / Terminal Sinks (Database Repositories, Kafka Producers, External Calls)
 * - Full Step-by-Step Execution Traces
 */

import * as path from 'path';
import { runPipelineFromRepo } from '../gitnexus_ts_isolated/src/ingestion/pipeline.js';

async function main() {
  const targetProject = process.argv[2] || 'sample_projects/spring-boot-demo';
  const resolvedRepoPath = path.resolve(process.cwd(), targetProject);

  console.log(`\n========================================================================`);
  console.log(`📍 CUSTOM BUSINESS FLOWS, ENTRY POINTS & EXIT POINTS INSPECTOR`);
  console.log(`   Target: ${resolvedRepoPath}`);
  console.log(`========================================================================\n`);

  const result = await runPipelineFromRepo(resolvedRepoPath, () => {}, {
    lsp: true,
    skipGraphPhases: false,
  });

  const graph = result.graph;
  const processNodes: any[] = [];

  for (const node of graph.iterNodes ? graph.iterNodes() : graph.nodes) {
    if (node.label === 'Process') {
      processNodes.push(node);
    }
  }

  // Map relationships to find entry point and step relationships
  const entryRels = new Map<string, string>(); // processId -> entryPointId

  for (const rel of graph.iterRelationships ? graph.iterRelationships() : graph.relationships) {
    if (rel.type === 'ENTRY_POINT_OF') {
      entryRels.set(rel.targetId, rel.sourceId);
    }
  }

  if (processNodes.length === 0) {
    console.log('No multi-step business processes detected in this codebase.');
    return;
  }

  console.log(`Detected ${processNodes.length} end-to-end execution flows:\n`);

  processNodes.forEach((proc, idx) => {
    const props = proc.properties || {};
    const entryId = props.entryPointId || entryRels.get(proc.id) || '(unknown)';
    const terminalId = props.terminalId || '(unknown)';
    const stepCount = props.stepCount || (props.trace ? props.trace.length : 0);

    const entryNode = graph.getNode ? graph.getNode(entryId) : null;
    const terminalNode = graph.getNode ? graph.getNode(terminalId) : null;

    const entryName = entryNode?.properties?.name || entryId.split(':').pop();
    const entryFile = entryNode?.properties?.filePath || '';
    const terminalName = terminalNode?.properties?.name || terminalId.split(':').pop();
    const terminalFile = terminalNode?.properties?.filePath || '';

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⚡ Flow #${idx + 1}: \x1b[1;36m${props.label || proc.id}\x1b[0m`);
    console.log(`   Type: ${props.processType || 'Execution Process'} | Steps: ${stepCount}`);
    console.log(`\n   🏁 \x1b[32mENTRY POINT:\x1b[0m ${entryName}`);
    if (entryFile) console.log(`      File: ${entryFile}:${entryNode?.properties?.startLine || 1}`);

    console.log(`\n   🛑 \x1b[31mEXIT POINT / TERMINAL SINK:\x1b[0m ${terminalName}`);
    if (terminalFile) console.log(`      File: ${terminalFile}:${terminalNode?.properties?.startLine || 1}`);

    if (props.trace && Array.isArray(props.trace)) {
      console.log(`\n   📋 \x1b[33mFull Execution Trace:\x1b[0m`);
      props.trace.forEach((stepId: string, sIdx: number) => {
        const sNode = graph.getNode ? graph.getNode(stepId) : null;
        const sName = sNode?.properties?.name || stepId.split(':').pop();
        const sFile = sNode?.properties?.filePath || '';
        const isFirst = sIdx === 0;
        const isLast = sIdx === props.trace.length - 1;
        const icon = isFirst ? '🏁 (Entry)' : isLast ? '🛑 (Exit) ' : '├── (Step) ';

        console.log(`      ${sIdx + 1}. \x1b[90m${icon}\x1b[0m \x1b[37m${sName}\x1b[0m \x1b[90m(${sFile})\x1b[0m`);
      });
    }
    console.log(`\n`);
  });

  console.log(`========================================================================\n`);
}

main().catch((err) => {
  console.error('Error inspecting flows:', err);
  process.exit(1);
});
