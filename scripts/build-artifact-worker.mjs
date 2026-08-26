import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { globSync } from 'glob';

const repository = path.resolve(import.meta.dirname, '..');
const asmJar = path.join(repository, 'vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar');
const checksumPath = path.join(repository, 'vendor/asm/asm-9.9.1.sha256');
const expectedAsmHash = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
const sourceRoot = path.join(repository, 'jvm_artifact_worker/src/main/java');
const outputRoot = path.join(repository, 'dist/jvm-artifact-worker');
const classes = path.join(outputRoot, 'classes');
const workerJar = path.join(outputRoot, 'gitnexus-artifact-worker.jar');
const javaHome = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
const executable = (name) => {
  if (javaHome) return path.join(javaHome, 'bin', name);
  const candidates = [
    ...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(`/opt/homebrew/opt/openjdk@21/bin/${name}`),
    ...globSync(path.join(process.env.USERPROFILE ?? '', `.jdks/*/bin/${name}.exe`)),
    ...globSync(path.join(process.env.HOME ?? '', `.local/jdks/*/bin/${name}`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? name;
};

const actualHash = createHash('sha256').update(fs.readFileSync(asmJar)).digest('hex');
if (actualHash !== expectedAsmHash) {
  throw new Error(`ASM Core checksum mismatch: expected ${expectedAsmHash}, got ${actualHash}`);
}

const sources = globSync(path.join(sourceRoot, '**/*.java')).sort();
if (sources.length === 0) throw new Error(`No artifact worker Java sources under ${sourceRoot}`);
fs.rmSync(classes, { recursive: true, force: true });
fs.mkdirSync(classes, { recursive: true });
execFileSync(executable('javac'), ['--release', '21', '-cp', asmJar, '-d', classes, ...sources], {
  stdio: 'inherit',
});
execFileSync(executable('jar'), [
  '--create', '--file', workerJar,
  '--main-class', 'io.gitnexus.artifact.ArtifactWorker',
  '-C', classes, '.',
], { stdio: 'inherit' });
console.log(`Built ${workerJar}`);
