import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'vendor', 'sootup', '2.0.0');
fs.mkdirSync(destination, { recursive: true });
execFileSync(process.env.MVN ?? 'mvn', [
  '-q', '-f', path.join(root, 'sootup_worker', 'pom.xml'),
  'dependency:copy-dependencies', `-DoutputDirectory=${destination}`,
  '-DincludeScope=runtime', '-Dmdep.stripVersion=false',
], { stdio: 'inherit' });
const listPath = path.join(destination, '.dependency-list.txt');
execFileSync(process.env.MVN ?? 'mvn', [
  '-q', '-f', path.join(root, 'sootup_worker', 'pom.xml'), 'dependency:list',
  '-DincludeScope=runtime', '-DoutputAbsoluteArtifactFilename=true', `-DoutputFile=${listPath}`,
], { stdio: 'inherit' });
const coordinates = new Map();
for (const raw of fs.readFileSync(listPath, 'utf8').replaceAll(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
  const match = raw.trim().match(/^([^:]+):([^:]+):jar:([^:]+):[^:]+:(.+\.jar)/);
  if (match) coordinates.set(path.basename(match[4]), {
    groupId: match[1], artifactId: match[2], version: match[3], jarPath: match[4],
  });
}
fs.rmSync(listPath, { force: true });
const files = fs.readdirSync(destination).filter((name) => name.endsWith('.jar')).sort();
const lock = {
  schemaVersion: 1,
  root: 'org.soot-oss:sootup.java.bytecode.frontend:2.0.0',
  artifacts: files.map((name) => {
    const coordinate = coordinates.get(name);
    if (!coordinate) throw new Error(`No Maven coordinate was resolved for ${name}`);
    const pom = localPom(coordinate.groupId, coordinate.artifactId, coordinate.version);
    return {
      name, coordinate: `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}`,
      sha256: createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex'),
      pomSha256: createHash('sha256').update(fs.readFileSync(pom)).digest('hex'),
      licenses: licenses(pom),
    };
  }),
};
fs.writeFileSync(path.join(destination, 'dependencies.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

function localPom(groupId, artifactId, version) {
  return path.join(os.homedir(), '.m2', 'repository', ...groupId.split('.'), artifactId, version,
    `${artifactId}-${version}.pom`);
}

function licenses(pomPath, visited = new Set()) {
  if (visited.has(pomPath) || !fs.existsSync(pomPath)) return [];
  visited.add(pomPath);
  const xml = fs.readFileSync(pomPath, 'utf8');
  const block = xml.match(/<licenses>([\s\S]*?)<\/licenses>/)?.[1] ?? '';
  const found = [...block.matchAll(/<license>([\s\S]*?)<\/license>/g)].map((match) => ({
    name: text(match[1], 'name') ?? 'unspecified', url: text(match[1], 'url') ?? null,
  }));
  if (found.length > 0) return found;
  const parent = xml.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (!parent) return [];
  const groupId = text(parent, 'groupId');
  const artifactId = text(parent, 'artifactId');
  const version = text(parent, 'version');
  return groupId && artifactId && version
    ? licenses(localPom(groupId, artifactId, version), visited) : [];
}

function text(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]?.trim();
}
