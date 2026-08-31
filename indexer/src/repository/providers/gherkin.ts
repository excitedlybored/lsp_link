import type { IRepositoryDocumentProvider, RepositoryDeclarationInput } from '../provider.js';
import { declarationsByLine } from './helpers.js';

export class GherkinDocumentProvider implements IRepositoryDocumentProvider {
  readonly metadata = {
    id: 'gherkin-lexical', version: '1', authority: 'structural_lexical' as const,
    languages: ['gherkin'], capabilities: ['declarations', 'source-ranges'],
    includeGlobs: ['**/*.feature'],
    documentKind: 'gherkin' as const,
  };

  supports(relativePath: string): boolean { return /\.feature$/i.test(relativePath); }
  languageId(): string { return 'gherkin'; }
  async index({ content }: { content: string }): Promise<RepositoryDeclarationInput[]> {
    return declarationsByLine(content, (line) => {
      const match = line.match(/^\s*(Feature|Rule|Background|Scenario Outline|Scenario|Examples|Given|When|Then|And|But)\s*:\s*(.+?)\s*$/i);
      return match ? [{ kind: match[1]!.toLowerCase().replaceAll(' ', '_'), name: match[2]! }] : [];
    });
  }
}
