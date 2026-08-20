/**
 * LSP Enrichment Pipeline Phase.
 *
 * Runs after `parsePhase` to query live Language Server Protocol adapters
 * (e.g. Eclipse JDT.LS) and inject compiler-accurate CALLS and IMPLEMENTS
 * edges into the KnowledgeGraph before it is written to the `.gitnexus/lbug` database.
 */

import { PipelinePhase, PhaseResult } from './types.js';
import { LspGraphEnricher } from '../../lsp/enricher/lsp-graph-enricher.js';

export interface LspEnrichmentOutput {
  enrichedCalls: number;
  enrichedImplementations: number;
  enrichedTypes: number;
}

export const lspEnrichmentPhase: PipelinePhase<LspEnrichmentOutput> = {
  name: 'lspEnrichment',
  dependsOn: ['parse'],
  execute: async ({ graph, repoPath, onProgress }): Promise<PhaseResult<LspEnrichmentOutput>> => {
    const enricher = new LspGraphEnricher();

    onProgress({
      phase: 'lspEnrichment',
      percent: 45,
      message: '⚡ Enriching knowledge graph with live Language Server Protocol (JDT.LS)...',
    });

    const stats = await enricher.enrich(graph, repoPath, (msg) => {
      onProgress({
        phase: 'lspEnrichment',
        percent: 50,
        message: msg,
      });
    });

    return {
      output: stats,
      stats: {
        enrichedCalls: stats.enrichedCalls,
        enrichedImplementations: stats.enrichedImplementations,
      },
    };
  },
};
