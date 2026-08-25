import type {
  LspAnalysisRun,
  LspBuildRoot,
  LspCallSite,
  LspCoverage,
  LspDiagnostic,
  LspDocument,
  LspHover,
  LspOccurrence,
  LspParameter,
  LspRelation,
  LspSemanticToken,
  LspServer,
  LspSignature,
  LspSignatureHelp,
  LspSymbol,
} from '../model.js';

/** Complete write unit for one or more provider observations. */
export interface LspObservationBatch {
  analysisRuns: LspAnalysisRun[];
  buildRoots: LspBuildRoot[];
  servers: LspServer[];
  documents: LspDocument[];
  symbols: LspSymbol[];
  callSites: LspCallSite[];
  occurrences: LspOccurrence[];
  diagnostics: LspDiagnostic[];
  coverage: LspCoverage[];
  hovers: LspHover[];
  semanticTokens: LspSemanticToken[];
  signatureHelps: LspSignatureHelp[];
  signatures: LspSignature[];
  parameters: LspParameter[];
  relations: LspRelation[];
}

export function emptyObservationBatch(): LspObservationBatch {
  return {
    analysisRuns: [], buildRoots: [], servers: [], documents: [], symbols: [], callSites: [],
    occurrences: [], diagnostics: [], coverage: [], hovers: [], semanticTokens: [],
    signatureHelps: [], signatures: [], parameters: [], relations: [],
  };
}

export function mergeObservationBatches(...batches: LspObservationBatch[]): LspObservationBatch {
  const merged = emptyObservationBatch();
  for (const batch of batches) {
    for (const key of Object.keys(merged) as Array<keyof LspObservationBatch>) {
      // All batch properties are homogeneous arrays at their own key.
      const target = merged[key] as unknown[];
      for (const value of batch[key] as unknown[]) target.push(value);
    }
  }
  return merged;
}

/** Last observation for an id wins; provider disagreement remains distinct because its ids include provenance. */
export function dedupeObservationBatch(batch: LspObservationBatch): LspObservationBatch {
  const deduped = emptyObservationBatch();
  for (const key of Object.keys(batch) as Array<keyof LspObservationBatch>) {
    const byId = new Map<string, unknown>();
    for (const value of batch[key] as Array<{ id: string }>) byId.set(value.id, value);
    const target = deduped[key] as unknown[];
    for (const value of byId.values()) target.push(value);
  }
  return deduped;
}
