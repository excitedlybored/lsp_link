import type { LspObservationBatch } from '../../ingest/batch.js';
import { rangeKey, stableId } from '../../ingest/builders.js';
import {
  LSP_RELATION_KIND,
  symbolNodeTable,
  type LspCallSite,
  type LspRange,
  type LspSymbol,
} from '../../model.js';
import {
  emptyDerivedCallNormalizationBatch,
  type DerivedCallNormalizationBatch,
  type LogicalInvocationStatus,
} from './model.js';

export const CALL_NORMALIZATION_ALGORITHM_VERSION = 'lsp-logical-call-v1';

interface CallCandidate {
  site: LspCallSite;
  targetFamilyId: string;
  targetFamilyStableKey: string;
  canonicalTarget?: LspSymbol;
  ambiguous: boolean;
}

export function normalizeLogicalCalls(
  lsp: LspObservationBatch,
): DerivedCallNormalizationBatch {
  const result = emptyDerivedCallNormalizationBatch();
  const startedAt = new Date().toISOString();
  const lspRunId = lsp.analysisRuns[0]?.id;
  if (!lspRunId) throw new Error('Call normalization requires an LSP analysis run');
  const stageId = stableId(
    'derived-call-normalization-stage', lspRunId, CALL_NORMALIZATION_ALGORITHM_VERSION,
  );
  const symbols = new Map(lsp.symbols.map((value) => [value.id, value]));
  const documents = new Map(lsp.documents.map((value) => [value.id, value]));
  const implementationParents = new Map<string, string>();
  const targetsByCallSite = new Map<string, LspSymbol[]>();

  for (const relation of lsp.relations) {
    if (relation.kind === LSP_RELATION_KIND.ImplementationOf) {
      implementationParents.set(relation.sourceId, relation.targetId);
    } else if (relation.kind === LSP_RELATION_KIND.ResolvesTo) {
      const target = symbols.get(relation.targetId);
      if (target) {
        targetsByCallSite.set(
          relation.sourceId,
          [...(targetsByCallSite.get(relation.sourceId) ?? []), target],
        );
      }
    }
  }

  const canonicalFamilyId = (id: string): string => {
    const visited = new Set<string>();
    let current = id;
    while (implementationParents.has(current) && !visited.has(current)) {
      visited.add(current);
      current = implementationParents.get(current)!;
    }
    return current;
  };

  const candidates: CallCandidate[] = [];
  let ambiguousObservationCount = 0;
  for (const site of lsp.callSites) {
    const targets = targetsByCallSite.get(site.id) ?? [];
    const families = new Map<string, LspSymbol | undefined>();
    for (const target of targets) {
      const familyId = canonicalFamilyId(target.id);
      families.set(familyId, symbols.get(familyId) ?? target);
    }
    if (families.size === 0) {
      const unresolvedKey = `unresolved:${site.calleeName ?? 'unknown'}`;
      candidates.push({
        site, targetFamilyId: unresolvedKey,
        targetFamilyStableKey: unresolvedKey, ambiguous: false,
      });
      continue;
    }
    const ambiguous = families.size > 1;
    if (ambiguous) ambiguousObservationCount += 1;
    for (const [familyId, canonicalTarget] of families) {
      candidates.push({
        site, targetFamilyId: familyId,
        targetFamilyStableKey: canonicalTarget?.stableKey ?? familyId,
        canonicalTarget, ambiguous,
      });
    }
  }

  const partitions = new Map<string, CallCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.site.runId,
      candidate.site.documentId,
      candidate.site.callerSymbolId,
      candidate.targetFamilyId,
    ].join('\0');
    partitions.set(key, [...(partitions.get(key) ?? []), candidate]);
  }

  let invocationOrdinal = 0;
  for (const partition of partitions.values()) {
    const clusters = clusterOverlappingCandidates(partition)
      .sort((left, right) => compareRanges(canonicalRange(left), canonicalRange(right)));
    for (const [familyOrdinal, cluster] of clusters.entries()) {
      const sites = [...new Map(cluster.map((value) => [value.site.id, value.site])).values()];
      const representative = chooseRepresentativeSite(sites);
      const caller = symbols.get(representative.callerSymbolId);
      const document = documents.get(representative.documentId);
      const canonicalTarget = cluster.find((value) => value.canonicalTarget)?.canonicalTarget;
      const status: LogicalInvocationStatus = cluster.some((value) => value.ambiguous)
        ? 'ambiguous'
        : canonicalTarget ? 'resolved' : 'unresolved';
      const directions = [...new Set(sites.map((value) => value.direction))].sort();
      const capabilities = [...new Set(sites.map((value) => value.capability))].sort();
      const stableKey = stableId(
        'semantic-logical-invocation',
        document?.uri ?? representative.documentId,
        caller?.stableKey ?? representative.callerSymbolId,
        partition[0]!.targetFamilyStableKey,
        String(familyOrdinal),
      );
      const id = stableId(
        'logical-invocation', stageId, representative.documentId,
        representative.callerSymbolId, partition[0]!.targetFamilyId,
        rangeKey(representative.range), String(familyOrdinal),
      );
      const confidence = status === 'ambiguous'
        ? 0.7
        : status === 'unresolved' ? 0.5 : directions.length > 1 ? 1 : 0.95;
      result.invocations.push({
        id, stageId, runId: representative.runId,
        documentId: representative.documentId,
        callerSymbolId: representative.callerSymbolId,
        callerStableKey: caller?.stableKey ?? representative.callerSymbolId,
        targetFamilyId: partition[0]!.targetFamilyId,
        targetFamilyStableKey: partition[0]!.targetFamilyStableKey,
        canonicalTargetId: canonicalTarget?.id,
        canonicalTargetKind: canonicalTarget ? symbolNodeTable(canonicalTarget.kindName) : undefined,
        startLine: representative.range.start.line,
        startCharacter: representative.range.start.character,
        endLine: representative.range.end.line,
        endCharacter: representative.range.end.character,
        observationCount: sites.length, directions, capabilities, stableKey,
        status, confidence, algorithmVersion: CALL_NORMALIZATION_ALGORITHM_VERSION,
      });
      result.relations.push({
        id: stableId('derived-call-relation', stageId, 'HAS_LOGICAL_INVOCATION', id),
        sourceKind: 'DerivedCallNormalizationRun', sourceId: stageId,
        targetKind: 'LspLogicalInvocation', targetId: id,
        kind: 'HAS_LOGICAL_INVOCATION', stageId, confidence, ordinal: invocationOrdinal,
      });
      for (const [ordinal, site] of sites.entries()) {
        result.relations.push({
          id: stableId('derived-call-relation', stageId, 'NORMALIZES_TO', site.id, id),
          sourceKind: 'LspCallSite', sourceId: site.id,
          targetKind: 'LspLogicalInvocation', targetId: id,
          kind: 'NORMALIZES_TO', stageId, confidence, ordinal,
        });
      }
      if (canonicalTarget) {
        result.relations.push({
          id: stableId(
            'derived-call-relation', stageId, 'LOGICAL_RESOLVES_TO', id, canonicalTarget.id,
          ),
          sourceKind: 'LspLogicalInvocation', sourceId: id,
          targetKind: symbolNodeTable(canonicalTarget.kindName), targetId: canonicalTarget.id,
          kind: 'LOGICAL_RESOLVES_TO', stageId, confidence, ordinal: 0,
        });
      }
      invocationOrdinal += 1;
    }
  }

  result.runs.push({
    id: stageId, lspRunId, status: 'complete',
    algorithmVersion: CALL_NORMALIZATION_ALGORITHM_VERSION,
    startedAt, completedAt: new Date().toISOString(),
    observationCount: lsp.callSites.length,
    invocationCount: result.invocations.length,
    normalizedObservationCount: new Set(candidates.map((value) => value.site.id)).size,
    ambiguousObservationCount, errorCount: 0,
  });
  return result;
}

function clusterOverlappingCandidates(candidates: CallCandidate[]): CallCandidate[][] {
  const parent = candidates.map((_, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]!]!;
      value = parent[value]!;
    }
    return value;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (rangesOverlap(candidates[left]!.site.range, candidates[right]!.site.range)) {
        union(left, right);
      }
    }
  }
  const clusters = new Map<number, CallCandidate[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), candidates[index]!]);
  }
  return [...clusters.values()];
}

function chooseRepresentativeSite(sites: LspCallSite[]): LspCallSite {
  return [...sites].sort((left, right) => {
    if (left.direction !== right.direction) return left.direction === 'outgoing' ? -1 : 1;
    const widthDifference = rangeWidth(right.range) - rangeWidth(left.range);
    return widthDifference || compareRanges(left.range, right.range);
  })[0]!;
}

function canonicalRange(cluster: CallCandidate[]): LspRange {
  return chooseRepresentativeSite(cluster.map((value) => value.site)).range;
}

function rangesOverlap(left: LspRange, right: LspRange): boolean {
  return comparePositions(left.start, right.end) < 0
    && comparePositions(right.start, left.end) < 0;
}

function compareRanges(left: LspRange, right: LspRange): number {
  return comparePositions(left.start, right.start) || comparePositions(left.end, right.end);
}

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}

function rangeWidth(range: LspRange): number {
  return (range.end.line - range.start.line) * 1_000_000
    + range.end.character - range.start.character;
}
