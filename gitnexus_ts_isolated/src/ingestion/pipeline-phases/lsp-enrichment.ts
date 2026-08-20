/**
 * LSP Enrichment Pipeline Phase with Graceful Fallback.
 *
 * Runs after `parsePhase` to query live Language Server Protocol adapters
 * (e.g. Eclipse JDT.LS) and inject compiler-accurate CALLS and IMPLEMENTS
 * edges into the KnowledgeGraph before it is written to the `.gitnexus/lbug` database.
 *
 * Fallback Guarantee:
 * If the LSP server is inactive, fails to start, or crashes, this phase
 * gracefully falls back to Tree-sitter AST and logs a diagnostic warning.
 */

import { PipelinePhase, PhaseResult } from './types.js';
import { LspGraphEnricher } from '../../lsp/enricher/lsp-graph-enricher.js';

export interface LspEnrichmentOutput {
  enrichedCalls: number;
  enrichedImplementations: number;
  conflictsResolved: number;
}

export const lspEnrichmentPhase: PipelinePhase<LspEnrichmentOutput> = {
  name: 'lspEnrichment',
  deps: ['parse'],
  execute: async ({ graph, repoPath, onProgress }): Promise<PhaseResult<LspEnrichmentOutput>> => {
    const enricher = new LspGraphEnricher();

    onProgress({
      phase: 'lspEnrichment',
      percent: 45,
      message: '⚡ Enriching knowledge graph with live Language Server Protocol (JDT.LS)...',
    });

    try {
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
          conflictsResolved: stats.conflictsResolved,
        },
      };
    } catch (err: any) {
      onProgress({
        phase: 'lspEnrichment',
        percent: 50,
        message: `⚠️ LSP server not active: ${err.message || 'unknown error'}. Falling back to Tree-sitter AST only.`,
      });

      return {
        output: {
          enrichedCalls: 0,
          enrichedImplementations: 0,
          conflictsResolved: 0,
        },
      };
    }
  },
};
