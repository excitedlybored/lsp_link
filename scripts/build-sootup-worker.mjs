import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = globSync(path.join(root, 'vendor/sootup/2.0.0/*.jar')).sort();
if (dependencies.length === 0) throw new Error('SootUp dependencies are missing; run npm run sootup:resolve');
const lockPath = path.join(root, 'vendor/sootup/2.0.0/dependencies.lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (dependencies.length !== lock.artifacts.length
  || dependencies.some((file) => !lock.artifacts.some((artifact) => artifact.name === path.basename(file)))) {
  throw new Error('Vendored SootUp JAR set does not exactly match dependencies.lock.json');
}
for (const artifact of lock.artifacts) {
  if (!artifact.coordinate || !artifact.pomSha256 || !Array.isArray(artifact.licenses)
    || artifact.licenses.length === 0) {
    throw new Error(`Incomplete SootUp dependency provenance: ${artifact.name}`);
  }
  const file = path.join(path.dirname(lockPath), artifact.name);
  if (!fs.existsSync(file)) throw new Error(`Missing locked SootUp dependency: ${artifact.name}`);
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== artifact.sha256) throw new Error(`SootUp dependency checksum mismatch: ${artifact.name}`);
}
const javaHome = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
const executable = (name) => {
  if (javaHome) return path.join(javaHome, 'bin', name);
  const candidates = [
    path.join(root, '.gitnexus', 'tools', 'jdk21', 'bin', name),
    ...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(`/opt/homebrew/opt/openjdk@21/bin/${name}`),
    ...globSync(path.join(process.env.USERPROFILE ?? '', `.jdks/*/bin/${name}.exe`)),
    ...globSync(path.join(process.env.HOME ?? '', `.local/jdks/*/bin/${name}`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? name;
};
const javac = executable('javac');
const jar = executable('jar');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sootup-build-'));
const classes = path.join(temporary, 'classes');
const output = path.join(root, 'dist', 'sootup-worker', 'gitnexus-sootup-worker.jar');
fs.mkdirSync(classes, { recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
try {
  const sources = globSync(path.join(root, 'sootup_worker/src/main/java/**/*.java')).sort();
  execFileSync(javac, ['--release', '21', '-cp', dependencies.join(path.delimiter), '-d', classes, ...sources], { stdio: 'inherit' });
  execFileSync(jar, ['--create', '--file', output, '-C', classes, '.'], { stdio: 'inherit' });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
