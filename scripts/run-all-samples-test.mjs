import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repositoryPath = path.resolve(import.meta.dirname, '..');
const result = spawnSync(process.execPath, [
  path.join(repositoryPath, 'node_modules/tsx/dist/cli.mjs'),
  '--test',
  path.join(repositoryPath, 'indexer/test/all-samples.test.ts'),
], {
  cwd: repositoryPath,
  env: { ...process.env, RUN_SAMPLE_INDEXER_E2E: '1' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
