import { globSync } from 'glob';

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
