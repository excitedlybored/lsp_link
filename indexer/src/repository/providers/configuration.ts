import path from 'node:path';
import type { IRepositoryDocumentProvider, RepositoryDeclarationInput } from '../provider.js';
import { declarationsByLine, type LineMatch } from './helpers.js';

const EXTENSIONS = new Set(['.yaml', '.yml', '.json', '.xml', '.properties', '.toml']);

export class ConfigurationDocumentProvider implements IRepositoryDocumentProvider {
  readonly metadata = {
    id: 'configuration-lexical', version: '1', authority: 'structural_lexical' as const,
    languages: ['yaml', 'yml', 'json', 'xml', 'properties', 'toml'],
    capabilities: ['keys', 'source-ranges'], documentKind: 'configuration' as const,
    includeGlobs: [
      '**/*.yaml', '**/*.yml', '**/*.json', '**/*.xml', '**/*.properties', '**/*.toml',
    ],
  };

  supports(relativePath: string): boolean { return EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()); }
  languageId(relativePath: string): string { return path.posix.extname(relativePath).slice(1).toLowerCase(); }
  async index({ content, document }: Parameters<IRepositoryDocumentProvider['index']>[0]): Promise<RepositoryDeclarationInput[]> {
    return declarationsByLine(content, (line) => configurationDeclarations(line, document.languageId));
  }
}

function configurationDeclarations(line: string, languageId: string): LineMatch[] {
  if (languageId === 'properties') {
    const match = line.match(/^\s*([^#!\s][^=:\s]*)\s*[:=]/);
    return match ? [{ kind: 'config_key', name: match[1]! }] : [];
  }
  if (languageId === 'yaml' || languageId === 'yml' || languageId === 'toml') {
    const match = line.match(/^\s*([A-Za-z_][\w.-]*)\s*[:=]/);
    return match ? [{ kind: 'config_key', name: match[1]! }] : [];
  }
  if (languageId === 'json') {
    return [...line.matchAll(/"([^"\\]+)"\s*:/g)].map((match) => ({
      kind: 'config_key', name: match[1]!, startCharacter: match.index + 1,
    }));
  }
  if (languageId === 'xml') {
    const match = line.match(/<([A-Za-z_][\w:.-]*)(?:\s|>|\/)/);
    return match ? [{ kind: 'config_element', name: match[1]! }] : [];
  }
  return [];
}
