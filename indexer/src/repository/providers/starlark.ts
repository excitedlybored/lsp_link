import path from 'node:path';
import type { IRepositoryDocumentProvider, RepositoryDeclarationInput } from '../provider.js';
import { declarationsByLine } from './helpers.js';

const BUILD_FILENAMES = new Set([
  'BUILD', 'BUILD.bazel', 'MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'REPO.bazel',
]);

export class StarlarkDocumentProvider implements IRepositoryDocumentProvider {
  readonly metadata = {
    id: 'starlark-lexical', version: '1', authority: 'structural_lexical' as const,
    languages: ['starlark'], capabilities: ['declarations', 'source-ranges', 'macro-definitions'],
    includeGlobs: [
      '**/*.bzl', '**/BUILD', '**/BUILD.bazel', 'MODULE.bazel', 'WORKSPACE',
      'WORKSPACE.bazel', 'REPO.bazel',
    ],
    documentKind: 'build_definition' as const,
  };

  supports(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.bzl') || BUILD_FILENAMES.has(path.posix.basename(relativePath));
  }
  languageId(): string { return 'starlark'; }
  async index({ content }: { content: string }): Promise<RepositoryDeclarationInput[]> {
    return declarationsByLine(content, (line) => {
      const functionMatch = line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
      if (functionMatch) return [{ kind: 'macro', name: functionMatch[1]! }];
      const targetMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
      return targetMatch ? [{ kind: 'target_name', name: targetMatch[1]! }] : [];
    });
  }
}
