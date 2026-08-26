import { globSync } from 'glob';
import path from 'node:path';
import type { JavaBuildRootPreparation } from './types.js';

export function findJavaSourceFiles(workspacePath: string): string[] {
  return globSync('**/*.java', {
    cwd: workspacePath,
    absolute: true,
    ignore: [
      '**/.git/**',
      '**/.gitnexus/**',
      '**/node_modules/**',
      '**/target/**',
      '**/build/**',
      '**/bazel-bin/**',
      '**/bazel-out/**',
      '**/bazel-testlogs/**',
    ],
  }).sort();
}

export function addConfiguredJavaSources(
  filesByRoot: Map<string, string[]>,
  preparations: Array<JavaBuildRootPreparation & { rootId: string }>,
): Map<string, string[]> {
  for (const preparation of preparations) {
    const files = new Set(filesByRoot.get(preparation.rootId) ?? []);
    for (const source of preparation.crawlSources ?? []) files.add(path.resolve(source.path));
    if (files.size > 0) filesByRoot.set(preparation.rootId, [...files].sort());
  }
  return filesByRoot;
}
