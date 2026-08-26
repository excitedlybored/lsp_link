import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globSync } from 'glob';
import type { LspObservationBatch } from '../ingest/batch.js';
import { symbolNodeTable } from '../model.js';
import { inferMavenCoordinateParts } from './classpath/index.js';
import type {
  JvmArtifact, JvmArtifactBatch, JvmEntityKind, JvmRelation, LspJvmBindingSourceKind,
} from './model.js';

export interface LspJvmMethodBindingRequest {
  sourceKind: LspJvmBindingSourceKind;
  sourceId: string;
  classId: string;
  memberName: string;
}

export function compactId(kind: string, ...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return `${kind}:${hash.digest('hex')}`;
}

export function createJvmRelation(
  stageId: string, sourceKind: JvmEntityKind, sourceId: string,
  targetKind: JvmEntityKind, targetId: string, kind: JvmRelation['kind'],
  ordinal: number, status: JvmRelation['status'] = 'observed',
): JvmRelation {
  return {
    id: compactId('jvm-relation', stageId, kind, sourceId, targetId, String(ordinal)),
    sourceKind, sourceId, targetKind, targetId, kind, stageId, status, ordinal,
  };
}

export function indexArtifactJarPaths(
  target: Map<string, JvmArtifact>, artifact: JvmArtifact,
  ...values: Array<string | undefined>
): void {
  for (const value of values) if (value) target.set(path.basename(value), artifact);
}

export function findExternalSeedClasses(
  lsp: LspObservationBatch,
  byJar: Map<string, JvmArtifact>,
): Array<{ artifactId: string; binaryName: string; uri: string }> {
  const result = new Map<string, { artifactId: string; binaryName: string; uri: string }>();
  const values = [
    ...lsp.occurrences.map((item) => item.uri), ...lsp.documents.map((item) => item.uri),
    ...lsp.symbols.map((item) => item.uri), ...lsp.hovers.map((item) => item.contents),
  ];
  for (const value of values) {
    for (const reference of resolveJdtReferences(value, byJar)) {
      result.set(`${reference.artifactId}\0${reference.binaryName}\0${reference.uri}`, reference);
    }
  }
  return [...result.values()];
}

export function buildLspJvmClassBindings(
  lsp: LspObservationBatch,
  stageId: string,
  byJar: Map<string, JvmArtifact>,
): JvmArtifactBatch['bindings'] {
  const bindings: JvmArtifactBatch['bindings'] = [];
  const append = (
    sourceKind: JvmArtifactBatch['bindings'][number]['sourceKind'], sourceId: string,
    value: string, kind: JvmArtifactBatch['bindings'][number]['kind'],
  ): void => {
    if (!sourceId) return;
    for (const reference of resolveJdtReferences(value, byJar)) {
      const classId = compactId('jvm-class', stageId, reference.artifactId, reference.binaryName);
      bindings.push({
        id: compactId('lsp-jvm-binding', stageId, sourceId, classId, kind),
        sourceKind, sourceId, targetKind: 'JvmClass', targetId: classId, kind, stageId,
        status: 'resolved', confidence: 1,
        reason: 'JDT dependency URI resolved to class in normalized artifact',
      });
    }
  };
  for (const symbol of lsp.symbols) {
    const isType = ['Class', 'Interface', 'Enum', 'Struct'].includes(symbol.kindName);
    append(symbolNodeTable(symbol.kindName), symbol.id, symbol.uri,
      isType ? 'SYMBOL_IDENTITY' : 'SYMBOL_OWNER');
  }
  for (const hover of lsp.hovers) append('LspHover', hover.id, hover.contents, 'HOVER_TARGET');
  for (const occurrence of lsp.occurrences) {
    append('LspOccurrence', occurrence.id, occurrence.uri, 'OCCURRENCE_TARGET');
  }
  return bindings;
}

/** Keep only LSP-referenced member names, not a repository-wide method index. */
export function findLspJvmMethodBindingRequests(
  lsp: LspObservationBatch,
  stageId: string,
  byJar: Map<string, JvmArtifact>,
): LspJvmMethodBindingRequest[] {
  const requests: LspJvmMethodBindingRequest[] = [];
  for (const symbol of lsp.symbols) {
    if (['Class', 'Interface', 'Enum', 'Struct'].includes(symbol.kindName)) continue;
    const memberName = symbol.name.split('(')[0]?.trim();
    if (!memberName) continue;
    for (const reference of resolveJdtReferences(symbol.uri, byJar)) {
      requests.push({
        sourceKind: symbolNodeTable(symbol.kindName), sourceId: symbol.id, memberName,
        classId: compactId('jvm-class', stageId, reference.artifactId, reference.binaryName),
      });
    }
  }
  return requests;
}

function resolveJdtReferences(
  value: string,
  byJar: Map<string, JvmArtifact>,
): Array<{ artifactId: string; binaryName: string; uri: string }> {
  if (typeof value !== 'string' || !value.includes('jdt://contents/')) return [];
  const results = [];
  const matches = value.matchAll(/jdt:\/\/contents\/([^/\s)]+\.jar)\/([^?\s)]+)\.java[^\s)]*/g);
  for (const match of matches) {
    const artifact = byJar.get(decodeURIComponent(match[1]!));
    if (!artifact) continue;
    const uri = match[0]!;
    const decoded = decodeURIComponent(uri);
    const exactClass = decoded.match(/<([\w.]+)\(([\w$]+)\.class/)?.slice(1);
    const binaryName = exactClass
      ? `${exactClass[0]}.${exactClass[1]}`
      : decodeURIComponent(match[2]!).replaceAll('/', '.');
    results.push({ artifactId: artifact.id, binaryName, uri });
  }
  return results;
}

export async function resolveSourceJar(
  artifactJar: string,
  cacheDirectory: string,
  allowDownload: boolean,
): Promise<{ path?: string; origin: JvmArtifact['sourceOrigin'] }> {
  const coordinate = inferMavenCoordinateParts(artifactJar);
  if (coordinate) {
    const local = path.join(os.homedir(), '.m2/repository', coordinate.group.replaceAll('.', '/'),
      coordinate.artifact, coordinate.version, `${coordinate.artifact}-${coordinate.version}-sources.jar`);
    if (fs.existsSync(local)) return { path: local, origin: 'local_maven' };
  }
  const sibling = globSync('*sources*.jar', { cwd: path.dirname(artifactJar), absolute: true })[0]
    ?? findGradleSourceJar(artifactJar, coordinate);
  if (sibling) return { path: sibling, origin: 'sibling' };
  if (!allowDownload || !coordinate) return { origin: 'unavailable' };
  const relative = path.join(
    coordinate.group.replaceAll('.', '/'), coordinate.artifact, coordinate.version,
    `${coordinate.artifact}-${coordinate.version}-sources.jar`,
  );
  const cached = path.join(cacheDirectory, 'artifact-sources', relative);
  if (fs.existsSync(cached)) return { path: cached, origin: 'downloaded' };
  const repository = mavenRepositoryUrl(artifactJar) ?? 'https://repo1.maven.org/maven2';
  try {
    const response = await fetch(`${repository}/${relative.replaceAll(path.sep, '/')}`, {
      signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'gitnexus-jvm-artifact-enrichment' },
    });
    if (!response.ok) return { origin: 'unavailable' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { origin: 'unavailable' };
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    const temporary = `${cached}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, cached);
    return { path: cached, origin: 'downloaded' };
  } catch {
    return { origin: 'unavailable' };
  }
}

function findGradleSourceJar(
  artifactJar: string,
  coordinate: { group: string; artifact: string; version: string } | undefined,
): string | undefined {
  if (!coordinate || !artifactJar.replaceAll('\\', '/').includes('/modules-2/files-2.1/')) return undefined;
  const versionDirectory = path.dirname(path.dirname(artifactJar));
  return globSync(`*/${coordinate.artifact}-${coordinate.version}-sources.jar`, {
    cwd: versionDirectory, absolute: true,
  })[0];
}

function mavenRepositoryUrl(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  const match = normalized.match(/\/v1\/(https?)\/([^/]+)\/(maven2|repository)\//);
  return match ? `${match[1]}://${match[2]}/${match[3]}` : undefined;
}
