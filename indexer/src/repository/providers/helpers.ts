import type { RepositoryDeclarationInput } from '../provider.js';

export interface LineMatch { kind: string; name: string; startCharacter?: number }

export function declarationsByLine(
  content: string,
  matcher: (line: string) => LineMatch[],
): RepositoryDeclarationInput[] {
  const declarations: RepositoryDeclarationInput[] = [];
  for (const [startLine, line] of content.split(/\r?\n/).entries()) {
    for (const match of matcher(line)) {
      const startCharacter = match.startCharacter ?? Math.max(0, line.indexOf(match.name));
      declarations.push({
        kind: match.kind, name: match.name, startLine, startCharacter,
        endLine: startLine, endCharacter: startCharacter + match.name.length,
      });
    }
  }
  return declarations;
}
