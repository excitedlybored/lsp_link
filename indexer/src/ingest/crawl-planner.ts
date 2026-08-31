import type { LspOccurrence, LspSemanticToken } from '../model.js';

export interface CrawlPlannerDecision {
  documentUri: string;
  line: number;
  character: number;
  tokenType: string;
  action: 'query' | 'covered';
  reason: 'unresolved-token' | 'covered-by-reference';
  coveringEvidenceIds: string[];
}

interface ReferenceSpan {
  occurrenceId: string;
  startCharacter: number;
  endCharacter: number;
}

/**
 * Index declaration-scoped reference results by returned document position.
 * These results already prove that a token is an occurrence of the requested
 * declaration, so the canonical crawl can reserve position queries for gaps.
 */
export class ReferenceCoverageIndex {
  private readonly spansByDocumentAndLine = new Map<string, Map<number, ReferenceSpan[]>>();

  constructor(occurrences: LspOccurrence[]) {
    for (const occurrence of occurrences) {
      if (occurrence.role !== 'reference' || occurrence.status !== 'mapped') continue;
      const range = occurrence.selectionRange ?? occurrence.range;
      const lines = this.spansByDocumentAndLine.get(occurrence.uri) ?? new Map<number, ReferenceSpan[]>();
      for (let line = range.start.line; line <= range.end.line; line += 1) {
        const spans = lines.get(line) ?? [];
        spans.push({
          occurrenceId: occurrence.id,
          startCharacter: line === range.start.line ? range.start.character : 0,
          endCharacter: line === range.end.line ? range.end.character : Number.MAX_SAFE_INTEGER,
        });
        lines.set(line, spans);
      }
      this.spansByDocumentAndLine.set(occurrence.uri, lines);
    }
  }

  coveringEvidence(documentUri: string, token: Pick<LspSemanticToken, 'line' | 'character' | 'length'>): string[] {
    const tokenEnd = token.character + token.length;
    return (this.spansByDocumentAndLine.get(documentUri)?.get(token.line) ?? [])
      .filter((span) => span.startCharacter <= token.character && span.endCharacter >= tokenEnd)
      .map((span) => span.occurrenceId)
      .sort();
  }
}

export function planSemanticTokenPosition(input: {
  documentUri: string;
  token: LspSemanticToken;
  referenceCoverage: ReferenceCoverageIndex;
}): CrawlPlannerDecision {
  const { documentUri, token, referenceCoverage } = input;
  const coveringEvidenceIds = referenceCoverage.coveringEvidence(documentUri, token);
  return coveringEvidenceIds.length > 0
    ? decision('covered', 'covered-by-reference', coveringEvidenceIds)
    : decision('query', 'unresolved-token', []);

  function decision(
    action: CrawlPlannerDecision['action'],
    reason: CrawlPlannerDecision['reason'],
    evidence: string[],
  ): CrawlPlannerDecision {
    return {
      documentUri, line: token.line, character: token.character,
      tokenType: token.tokenType, action, reason, coveringEvidenceIds: evidence,
    };
  }
}
