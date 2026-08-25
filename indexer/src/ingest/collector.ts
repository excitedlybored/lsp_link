import { LSP_RELATION_KIND, type LspCoverage, type LspRelation } from '../model.js';
import { emptyObservationBatch, mergeObservationBatches, type LspObservationBatch } from './batch.js';

/** Semantic capability inventory whose absence must be explained by coverage. */
export const LSP_KG_CAPABILITIES = [
  'textDocument/documentSymbol',
  'callHierarchy/outgoingCalls',
  'callHierarchy/incomingCalls',
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/references',
  'textDocument/implementation',
  'typeHierarchy/supertypes',
  'typeHierarchy/subtypes',
  'textDocument/hover',
  'textDocument/publishDiagnostics',
  'textDocument/diagnostic',
  'workspace/diagnostic',
  'textDocument/semanticTokens/full',
  'textDocument/semanticTokens/full/delta',
  'textDocument/semanticTokens/range',
  'textDocument/signatureHelp',
] as const;

export interface CapabilityTask {
  capability: string;
  languageId: string;
  documentId?: string;
  eligibleCount: number;
  /** False records unsupported without executing the task. */
  supported: boolean;
  execute(): Promise<LspObservationBatch>;
}

export interface CollectorContext {
  runId: string;
  serverId: string;
}

/** Adds explicit unsupported tasks for every semantic capability not scheduled. */
export function withCompleteCapabilityCoverage(
  tasks: CapabilityTask[],
  languageId: string,
  documentId?: string,
): CapabilityTask[] {
  const scheduled = new Set(tasks.map((task) => task.capability));
  const completed = [...tasks];
  for (const capability of LSP_KG_CAPABILITIES) {
    if (scheduled.has(capability)) continue;
    completed.push({
      capability, languageId, documentId, eligibleCount: 0, supported: false,
      async execute() { return emptyObservationBatch(); },
    });
  }
  return completed;
}

/** Executes capability work without turning absence or failure into negative knowledge. */
export async function collectCapabilities(
  context: CollectorContext,
  tasks: CapabilityTask[],
): Promise<LspObservationBatch> {
  const collected = emptyObservationBatch();
  for (const [ordinal, task] of tasks.entries()) {
    const started = task.supported && task.eligibleCount > 0;
    let observation = emptyObservationBatch();
    let failure = false;
    let timeout = false;
    if (started) {
      try {
        observation = await task.execute();
      } catch (error) {
        failure = true;
        timeout = error instanceof Error && /timeout|timed out/i.test(error.message);
      }
    }

    const counts = countObservationResults(observation);
    const status = !task.supported
      ? 'unsupported'
      : task.eligibleCount === 0
        ? 'excluded'
        : timeout
          ? 'timeout'
          : failure
            ? 'failed'
            : counts.resultCount === 0
              ? 'empty'
              : 'observed';
    const coverage: LspCoverage = {
      id: coverageId(context, task),
      runId: context.runId,
      serverId: context.serverId,
      documentId: task.documentId,
      languageId: task.languageId,
      capability: task.capability,
      status,
      eligibleCount: task.eligibleCount,
      attemptedCount: started ? task.eligibleCount : 0,
      successCount: started && !failure ? task.eligibleCount : 0,
      emptyCount: started && !failure && counts.resultCount === 0 ? task.eligibleCount : 0,
      failureCount: failure && !timeout ? task.eligibleCount : 0,
      timeoutCount: timeout ? task.eligibleCount : 0,
      resultCount: counts.resultCount,
      mappedCount: counts.mappedCount,
      externalCount: observation.symbols.filter((symbol) => symbol.isExternal).length,
      unmappedCount: counts.unmappedCount,
      exclusionReason: task.supported && task.eligibleCount === 0
        ? 'no eligible request positions'
        : undefined,
    };
    collected.coverage.push(coverage);
    collected.relations.push(coverageRelation(context, coverage, ordinal));
    if (!failure) mergeInto(collected, observation);
  }
  return collected;
}

function countObservationResults(batch: LspObservationBatch): {
  resultCount: number;
  mappedCount: number;
  unmappedCount: number;
} {
  const entities = batch.symbols.length + batch.callSites.length + batch.occurrences.length +
    batch.diagnostics.length + batch.hovers.length + batch.semanticTokens.length +
    batch.signatureHelps.length + batch.signatures.length + batch.parameters.length;
  const observedRelations = batch.relations.filter((relation) =>
    ![LSP_RELATION_KIND.UsesServer, LSP_RELATION_KIND.AnalyzedDocument, LSP_RELATION_KIND.ReportsCoverage]
      .includes(relation.kind as never),
  );
  return {
    resultCount: entities,
    mappedCount: observedRelations.filter((relation) => relation.status === 'mapped').length,
    unmappedCount: batch.occurrences.filter((occurrence) => occurrence.status === 'unmapped').length +
      observedRelations.filter((relation) => relation.status === 'unmapped').length,
  };
}

function coverageRelation(
  context: CollectorContext,
  coverage: LspCoverage,
  ordinal: number,
): LspRelation {
  return {
    id: `${coverage.id}:relation`,
    sourceKind: 'LspServer', sourceId: context.serverId,
    targetKind: 'LspCoverage', targetId: coverage.id,
    kind: LSP_RELATION_KIND.ReportsCoverage,
    runId: context.runId, serverId: context.serverId,
    capability: coverage.capability, status: coverage.status,
    providerAuthority: 1, mappingConfidence: 1, isDerived: false, ordinal,
  };
}

function coverageId(context: CollectorContext, task: CapabilityTask): string {
  return [context.runId, context.serverId, task.documentId ?? 'workspace', task.capability]
    .map(encodeURIComponent)
    .join(':');
}

function mergeInto(target: LspObservationBatch, source: LspObservationBatch): void {
  const merged = mergeObservationBatches(target, source);
  for (const key of Object.keys(target) as Array<keyof LspObservationBatch>) {
    const destination = target[key] as unknown[];
    destination.length = 0;
    for (const value of merged[key] as unknown[]) destination.push(value);
  }
}
