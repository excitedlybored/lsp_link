import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDirectory = path.join(repository, 'apps');
const requestedConcurrency = Number(process.argv[2] ?? 4);
if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
  throw new Error(`Concurrency must be a positive integer, got ${requestedConcurrency}`);
}

const applications = fs.readdirSync(appsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(appsDirectory, entry.name, 'MODULE.bazel')))
  .map((entry) => entry.name)
  .sort();
const failures = [];
let nextIndex = 0;
let completed = 0;

await Promise.all(Array.from(
  { length: Math.min(requestedConcurrency, applications.length) },
  async (_, workerIndex) => {
    while (nextIndex < applications.length) {
      const index = nextIndex++;
      const application = applications[index];
      const result = await buildApplication(application, workerIndex);
      completed += 1;
      if (result.exitCode === 0) {
        console.log(`[${completed}/${applications.length}] ${application}: passed`);
      } else {
        failures.push({ application, output: result.output });
        console.error(`[${completed}/${applications.length}] ${application}: failed`);
      }
    }
  },
));

for (const failure of failures) {
  console.error(`\n--- ${failure.application} ---\n${failure.output}`);
}
if (failures.length > 0) process.exitCode = 1;
else console.log(`All ${applications.length} Bazel roots compile.`);

function buildApplication(application, workerIndex) {
  return new Promise((resolve) => {
    // Each application is its own Bazel workspace. Batch mode prevents a
    // 60-root verification from retaining 60 independent server JVMs. Four
    // reusable output bases also bound disk consumption and share downloads
    // across the sequence handled by each worker.
    const outputBase = path.join(repository, '.bazel-verify', `worker-${workerIndex}`);
    const child = spawn('bazel', ['--batch', `--output_base=${outputBase}`, 'build', '//:all'], {
      cwd: path.join(appsDirectory, application),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ exitCode: 1, output: `${output}\n${error.stack ?? error.message}` }));
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, output }));
  });
}
