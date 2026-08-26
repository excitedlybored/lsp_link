import type { LspRange, LspRelation, LspSymbol } from '../model.js';
import type { LspObservationBatch } from './batch.js';

export interface CrawlSemanticInventory {
  documents: string[];
  symbols: string[];
  references: string[];
  callSites: string[];
  semanticRelations: string[];
  diagnostics: string[];
  semanticTokens: string[];
  signatures: string[];
}

export interface SemanticInventoryDifference {
  category: keyof CrawlSemanticInventory;
  missing: string[];
  unexpected: string[];
}

export interface SemanticInventoryComparison {
  equivalent: boolean;
  differences: SemanticInventoryDifference[];
}

/**
 * Build a planner-independent inventory of discovered semantic facts. Raw
 * request-specific definition/declaration/hover observations are deliberately
 * excluded: facts-first validation asks whether they discovered any additional
 * entity or relation, not whether both planners issued identical RPCs.
 */
export function buildCrawlSemanticInventory(batch: LspObservationBatch): CrawlSemanticInventory {
  const symbolKeys = new Map(batch.symbols.map((symbol) => [symbol.id, symbolKey(symbol)]));
  const relationBySource = relationsBySourceId(batch.relations);
  const documentUris = new Map(batch.documents.map((document) => [document.id, document.uri]));
  const signaturesByHelp = new Map<string, typeof batch.signatures>();
  for (const signature of batch.signatures) {
    const values = signaturesByHelp.get(signature.signatureHelpId) ?? [];
    values.push(signature);
    signaturesByHelp.set(signature.signatureHelpId, values);
  }

  return {
    documents: sortedUnique(batch.documents.map((document) => document.uri)),
    symbols: sortedUnique(batch.symbols.map(symbolKey)),
    references: sortedUnique(batch.occurrences
      .filter((occurrence) => occurrence.role === 'reference')
      .map((occurrence) => {
        const target = (relationBySource.get(occurrence.id) ?? [])
          .find((relation) => relation.kind === 'REFERENCE_TO');
        return [occurrence.uri, rangeKey(occurrence.range), target ? symbolKeys.get(target.targetId) : undefined]
          .filter((value) => value !== undefined).join('|');
      })),
    callSites: sortedUnique(batch.callSites.map((site) => {
      const target = (relationBySource.get(site.id) ?? []).find((relation) => relation.kind === 'RESOLVES_TO');
      return [symbolKeys.get(site.callerSymbolId) ?? site.callerSymbolId, documentUris.get(site.documentId),
        rangeKey(site.range), target ? symbolKeys.get(target.targetId) : site.calleeName]
        .filter((value) => value !== undefined).join('|');
    })),
    semanticRelations: sortedUnique(batch.relations
      .filter((relation) => relation.kind === 'IMPLEMENTATION_OF' || relation.kind === 'TYPE_HIERARCHY_SUPERTYPE')
      .map((relation) => [relation.kind, symbolKeys.get(relation.sourceId) ?? relation.sourceId,
        symbolKeys.get(relation.targetId) ?? relation.targetId].join('|'))),
    diagnostics: sortedUnique(batch.diagnostics.map((diagnostic) => [
      documentUris.get(diagnostic.documentId), rangeKey(diagnostic.range), diagnostic.severity,
      diagnostic.code, diagnostic.source, diagnostic.message,
    ].filter((value) => value !== undefined).join('|'))),
    semanticTokens: sortedUnique(batch.semanticTokens.map((token) => [
      documentUris.get(token.documentId), token.line, token.character, token.length,
      token.tokenType, [...token.tokenModifiers].sort().join(','),
    ].join('|'))),
    signatures: sortedUnique(batch.signatureHelps.map((help) => [
      documentUris.get(help.documentId), help.requestPosition.line, help.requestPosition.character,
      ...(signaturesByHelp.get(help.id) ?? [])
        .sort((left, right) => left.ordinal - right.ordinal).map((signature) => signature.label),
    ].join('|'))),
  };
}

export function compareCrawlSemanticInventories(
  original: LspObservationBatch,
  candidate: LspObservationBatch,
): SemanticInventoryComparison {
  const left = buildCrawlSemanticInventory(original);
  const right = buildCrawlSemanticInventory(candidate);
  const differences = (Object.keys(left) as Array<keyof CrawlSemanticInventory>).map((category) => {
    const leftKeys = new Set(left[category]);
    const rightKeys = new Set(right[category]);
    return {
      category,
      missing: left[category].filter((key) => !rightKeys.has(key)),
      unexpected: right[category].filter((key) => !leftKeys.has(key)),
    };
  }).filter((difference) => difference.missing.length > 0 || difference.unexpected.length > 0);
  return { equivalent: differences.length === 0, differences };
}

function relationsBySourceId(relations: LspRelation[]): Map<string, LspRelation[]> {
  const result = new Map<string, LspRelation[]>();
  for (const relation of relations) {
    const values = result.get(relation.sourceId) ?? [];
    values.push(relation);
    result.set(relation.sourceId, values);
  }
  return result;
}

function symbolKey(symbol: LspSymbol): string {
  return [symbol.uri, symbol.kindName, rangeKey(symbol.selectionRange), symbol.name, symbol.detail ?? ''].join('|');
}

function rangeKey(range: LspRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
