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
 * Build a request-schedule-independent inventory of discovered semantic facts. Raw
 * request-specific definition/declaration/hover observations are deliberately
 * excluded: comparisons ask whether runs discovered any additional entity or
 * relation, not whether both runs issued identical RPCs.
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

/** Release gate for the batch JDT provider: additions are allowed, missing required Java facts are not. */
export function compareRequiredJavaBatchInventories(
  exhaustive: LspObservationBatch,
  batch: LspObservationBatch,
): SemanticInventoryComparison {
  const authoritativeUris = new Set(batch.documents
    .filter((document) => document.languageId === 'java' && !document.uri.startsWith('jdt:'))
    .map((document) => document.uri));
  const candidateSymbols = requiredSourceSymbols(batch, authoritativeUris);
  const left = buildRequiredJavaSourceInventory(exhaustive, authoritativeUris, candidateSymbols);
  const right = buildRequiredJavaSourceInventory(batch, authoritativeUris, candidateSymbols);
  const required: Array<keyof CrawlSemanticInventory> = ['symbols', 'references', 'callSites', 'semanticRelations'];
  const differences = required.map((category) => {
    const rightKeys = new Set(right[category]);
    return { category, missing: left[category].filter((key) => !rightKeys.has(key)), unexpected: [] };
  }).filter((difference) => difference.missing.length > 0);
  return { equivalent: differences.length === 0, differences };
}

/**
 * Normalize the two intentionally different providers to their common source
 * contract. The exhaustive provider materializes external `jdt:` documents
 * and returns expression-sized ranges; the batch provider leaves dependencies
 * to ASM and reports identifier-sized ranges. Neither difference is a missing
 * authoritative source fact.
 */
function buildRequiredJavaSourceInventory(
  batch: LspObservationBatch,
  authoritativeUris: Set<string>,
  candidateSymbols: Set<string>,
): CrawlSemanticInventory {
  const symbolsById = new Map(batch.symbols.map((symbol) => [symbol.id, symbol]));
  const normalizedById = new Map(batch.symbols.map((symbol) => [symbol.id, requiredSymbolKey(symbol)]));
  const relationBySource = relationsBySourceId(batch.relations);
  const requiredSymbols = batch.symbols.filter((symbol) =>
    authoritativeUris.has(symbol.uri) && isRequiredNamedSourceSymbol(symbol));
  const declarationPositions = new Set(requiredSymbols.map((symbol) =>
    `${symbol.uri}|${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`));
  const rawSourceTarget = (id: string): string | undefined => {
    const symbol = symbolsById.get(id);
    if (!symbol || !authoritativeUris.has(symbol.uri) || !isRequiredNamedSourceSymbol(symbol)) return undefined;
    const key = normalizedById.get(id);
    return key && candidateSymbols.has(key) ? key : undefined;
  };
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const current = parent.get(key);
    if (!current || current === key) return key;
    const root = find(current); parent.set(key, root); return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left), rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const first = leftRoot < rightRoot ? leftRoot : rightRoot;
    parent.set(leftRoot, first); parent.set(rightRoot, first);
  };
  for (const relation of batch.relations) {
    if (relation.kind !== 'IMPLEMENTATION_OF' && relation.kind !== 'TYPE_HIERARCHY_SUPERTYPE') continue;
    const source = rawSourceTarget(relation.sourceId), target = rawSourceTarget(relation.targetId);
    if (!source || !target) continue;
    union(source, target);
  }
  const fieldsByUriAndName = new Map<string, string>();
  for (const symbol of requiredSymbols) {
    if (symbol.kindName === 'Field' || symbol.kindName === 'Constant' || symbol.kindName === 'Property') {
      fieldsByUriAndName.set(`${symbol.uri}|${normalizeDeclarationName(symbol.name)}`, requiredSymbolKey(symbol));
    }
  }
  for (const symbol of requiredSymbols) {
    if (symbol.kindName !== 'Method') continue;
    const match = /^(?:get|set|is)([A-Z].*)$/.exec(normalizeDeclarationName(symbol.name));
    if (!match) continue;
    const suffix = match[1]!;
    const property = suffix.length > 1 && /[A-Z]/.test(suffix[1]!)
      ? suffix : suffix[0]!.toLowerCase() + suffix.slice(1);
    const field = fieldsByUriAndName.get(`${symbol.uri}|${property}`);
    if (field) union(requiredSymbolKey(symbol), field);
  }
  const sourceTarget = (id: string): string | undefined => {
    const raw = rawSourceTarget(id);
    return raw ? find(raw) : undefined;
  };

  return {
    documents: sortedUnique([...authoritativeUris]),
    symbols: sortedUnique(requiredSymbols.map(requiredSymbolKey)),
    references: sortedUnique(batch.occurrences.flatMap((occurrence) => {
      if (occurrence.role !== 'reference' || !authoritativeUris.has(occurrence.uri)) return [];
      const targetRelation = (relationBySource.get(occurrence.id) ?? [])
        .find((relation) => relation.kind === 'REFERENCE_TO');
      const target = targetRelation ? symbolsById.get(targetRelation.targetId) : undefined;
      const targetKey = targetRelation ? sourceTarget(targetRelation.targetId) : undefined;
      if (!target || !targetKey) return [];
      // JDT's references response treats package imports, constructor uses,
      // and overriding declarations as references. Batch facts represent
      // those more precisely as declarations, calls, and override edges.
      if (target.kindName === 'Package' || target.kindName === 'Constructor') return [];
      if (declarationPositions.has(`${occurrence.uri}|${occurrence.range.start.line}:${occurrence.range.start.character}`)) return [];
      // Exhaustive references include the queried declaration itself. The AST
      // stream correctly classifies that token as a declaration, not a use.
      if (occurrence.uri === target.uri && samePosition(occurrence.range.start, target.selectionRange.start)) return [];
      return [`${occurrence.uri}|${occurrence.range.start.line}|${targetKey}`];
    })),
    callSites: sortedUnique(batch.callSites.flatMap((site) => {
      const caller = sourceTarget(site.callerSymbolId);
      const targetRelation = (relationBySource.get(site.id) ?? [])
        .find((relation) => relation.kind === 'RESOLVES_TO');
      const target = targetRelation ? sourceTarget(targetRelation.targetId) : undefined;
      const targetSymbol = targetRelation ? symbolsById.get(targetRelation.targetId) : undefined;
      // JDT call hierarchy models `new Interface() { ... }` as a synthetic
      // call to the interface. There is no Java constructor binding for that
      // event; the anonymous implementation is covered by type/override facts.
      if (targetSymbol?.kindName === 'Interface') return [];
      return caller && target ? [`${caller}|${target}`] : [];
    })),
    semanticRelations: sortedUnique(batch.relations.flatMap((relation) => {
      if (relation.kind !== 'IMPLEMENTATION_OF' && relation.kind !== 'TYPE_HIERARCHY_SUPERTYPE') return [];
      const source = sourceTarget(relation.sourceId);
      const target = sourceTarget(relation.targetId);
      if (!source || !target) return [];
      const sourceSymbol = symbolsById.get(relation.sourceId);
      const category = sourceSymbol?.kindName === 'Method' || sourceSymbol?.kindName === 'Constructor'
        ? 'override' : 'type-hierarchy';
      return [`${category}|${source}|${target}`];
    })),
    diagnostics: [], semanticTokens: [], signatures: [],
  };
}

function requiredSourceSymbols(batch: LspObservationBatch, authoritativeUris: Set<string>): Set<string> {
  return new Set(batch.symbols
    .filter((symbol) => authoritativeUris.has(symbol.uri) && isRequiredNamedSourceSymbol(symbol))
    .map(requiredSymbolKey));
}

function isRequiredNamedSourceSymbol(symbol: LspSymbol): boolean {
  const name = symbol.name.trim().toLowerCase();
  return !name.startsWith('new ') && !name.startsWith('anonymous') && !name.startsWith('<anonymous');
}

function requiredSymbolKey(symbol: LspSymbol): string {
  const normalizedName = normalizeDeclarationName(symbol.name);
  if (symbol.kindName === 'Package') return `${symbol.uri}|package|${normalizedName}`;
  return `${symbol.uri}|${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}|${normalizedName}`;
}

function normalizeDeclarationName(name: string): string {
  const trimmed = name.trim();
  const method = trimmed.indexOf('(');
  const generic = trimmed.indexOf('<');
  const detail = trimmed.indexOf(' : ');
  const cuts = [method, generic, detail].filter((value) => value >= 0);
  return cuts.length === 0 ? trimmed : trimmed.slice(0, Math.min(...cuts));
}

function samePosition(left: { line: number; character: number }, right: { line: number; character: number }): boolean {
  return left.line === right.line && left.character === right.character;
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
