import type { IRepositoryDocumentProvider, RepositoryDeclarationInput } from '../provider.js';
import { declarationsByLine, type LineMatch } from './helpers.js';

export class KotlinDocumentProvider implements IRepositoryDocumentProvider {
  readonly metadata = {
    id: 'kotlin-lexical', version: '1', authority: 'structural_lexical' as const,
    languages: ['kotlin'], capabilities: ['declarations', 'source-ranges'],
    includeGlobs: ['**/*.kt', '**/*.kts'],
    documentKind: 'source' as const,
  };

  supports(relativePath: string): boolean { return /\.(?:kt|kts)$/i.test(relativePath); }
  languageId(): string { return 'kotlin'; }
  async index({ content }: { content: string }): Promise<RepositoryDeclarationInput[]> {
    return declarationsByLine(content, kotlinDeclarations);
  }
}

function kotlinDeclarations(line: string): LineMatch[] {
  const result: LineMatch[] = [];
  const packageMatch = line.match(/^\s*package\s+([A-Za-z_][\w.]*)/);
  if (packageMatch) result.push({ kind: 'package', name: packageMatch[1]! });
  const typeMatch = line.match(/^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|value|annotation|expect|actual)\s+)*(enum\s+class|class|interface|object)\s+([A-Za-z_]\w*)/);
  if (typeMatch) result.push({ kind: typeMatch[1]!.replace(/\s+/g, '_'), name: typeMatch[2]! });
  const functionMatch = line.match(/^\s*(?:(?:public|private|protected|internal|open|abstract|override|suspend|inline|tailrec|operator|infix|external|expect|actual)\s+)*fun(?:\s+<[^>]+>)?\s+(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/);
  if (functionMatch) result.push({ kind: 'function', name: functionMatch[1]! });
  return result;
}
