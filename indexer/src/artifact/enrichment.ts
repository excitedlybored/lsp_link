import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { globSync } from 'glob';
import type { LspObservationBatch } from '../ingest/batch.js';
import { stableId } from '../ingest/builders.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifact,
  type JvmArtifactBatch,
  type JvmClass,
  type JvmEntityKind,
  type JvmField,
  type JvmMethod,
  type JvmRelation,
} from './model.js';
import {
  inferMavenCoordinate,
  inferMavenCoordinateParts,
  type NormalizedArtifactDescriptor,
  type ArtifactClasspathProviderAttempt,
} from './classpath/index.js';

const execFileAsync = promisify(execFile);

export interface JvmArtifactEnrichmentInput {
  lspRunId: string;
  artifacts: NormalizedArtifactDescriptor[];
  cacheDirectory: string;
  classpathAttempts?: ArtifactClasspathProviderAttempt[];
  lspBatch: LspObservationBatch;
  maxDisassembledClasses?: number;
  fetchSources?: boolean;
}

export async function enrichJvmArtifacts(input: JvmArtifactEnrichmentInput): Promise<JvmArtifactBatch> {
  const batch = emptyJvmArtifactBatch();
  const startedAt = new Date().toISOString();
  const stageId = stableId('jvm-artifact-stage', input.lspRunId);
  const configuredMaximum = input.maxDisassembledClasses
    ?? positiveInteger(process.env.GITNEXUS_JVM_MAX_CLASSES);
  const maxClasses = configuredMaximum ?? Number.POSITIVE_INFINITY;
  const fetchSources = input.fetchSources ?? process.env.GITNEXUS_JVM_FETCH_SOURCES !== '0';
  const classpathAttempts = input.classpathAttempts ?? [];
  const classpathErrorCount = classpathAttempts.filter((value) => value.status === 'failed').length;
  let errors = 0;

  const artifactsByJar = new Map<string, JvmArtifact>();
  const classByName = new Map<string, JvmClass>();
  const classByArtifactAndName = new Map<string, JvmClass>();
  for (const descriptor of input.artifacts) {
      const classpathEntryPath = path.resolve(descriptor.classpathEntryPath);
      const headerJarPath = descriptor.headerJarPath ? path.resolve(descriptor.headerJarPath) : undefined;
      const binaryJarPath = descriptor.binaryJarPath ? path.resolve(descriptor.binaryJarPath) : undefined;
      const crawlJarPath = binaryJarPath ?? headerJarPath ?? classpathEntryPath;
      if (!fs.existsSync(crawlJarPath)) continue;
      const coordinate = descriptor.coordinate ?? inferMavenCoordinate(crawlJarPath);
      const artifactId = compactId(
        'jvm-artifact', stageId,
        coordinate ?? crawlJarPath,
        path.basename(crawlJarPath).replace(/^(?:header_|processed_)/, ''),
      );
      const existingArtifact = batch.artifacts.find((value) => value.id === artifactId);
      if (existingArtifact) {
        if (!existingArtifact.buildRootIds.includes(descriptor.buildRootId)) existingArtifact.buildRootIds.push(descriptor.buildRootId);
        existingArtifact.classpathProviders = [...new Set([...existingArtifact.classpathProviders, ...descriptor.providerIds])];
        existingArtifact.classpathScopes = [...new Set([...existingArtifact.classpathScopes, descriptor.scope])];
        existingArtifact.modulePath ||= descriptor.modulePath;
        indexArtifactJarPaths(artifactsByJar, existingArtifact, classpathEntryPath, headerJarPath, binaryJarPath);
        continue;
      }
      const source = descriptor.sourceJarPath
        ? { path: path.resolve(descriptor.sourceJarPath), origin: 'provided' as const }
        : await resolveSourceJar(crawlJarPath, input.cacheDirectory, fetchSources);
      const sourceJarPath = source.path;
      const artifact: JvmArtifact = {
        id: artifactId,
        stageId, buildRootIds: [descriptor.buildRootId],
        classpathProviders: [...descriptor.providerIds], classpathScopes: [descriptor.scope],
        modulePath: descriptor.modulePath, coordinate, classpathEntryPath,
        headerJarPath, binaryJarPath, sourceJarPath,
        sourceOrigin: source.origin,
        associationStatus: sourceJarPath && binaryJarPath ? 'complete' : binaryJarPath ? 'binary_only' : 'header_only',
        classCount: 0,
      };
      batch.artifacts.push(artifact);
      indexArtifactJarPaths(artifactsByJar, artifact, classpathEntryPath, headerJarPath, binaryJarPath);
      batch.relations.push(createJvmRelation(stageId, 'JvmArtifactEnrichmentRun', stageId,
        'JvmArtifact', artifact.id, 'HAS_ARTIFACT', batch.artifacts.length - 1));

      try {
        const entries = await listJarClassEntries(crawlJarPath);
        for (const entry of entries) {
          if (!entry.endsWith('.class') || /(?:module-info|package-info)\.class$/.test(entry)) continue;
          const binaryName = entry.slice(0, -6).replaceAll('/', '.');
          const simpleName = binaryName.slice(binaryName.lastIndexOf('.') + 1);
          const clazz: JvmClass = {
            id: compactId('jvm-class', stageId, artifact.id, binaryName), stageId, artifactId: artifact.id,
            binaryName, packageName: binaryName.includes('.') ? binaryName.slice(0, binaryName.lastIndexOf('.')) : '',
            simpleName, kind: 'unknown', interfaces: [],
            sourceEntry: sourceJarPath
              ? `${binaryName.replaceAll('.', '/').replace(/\$.*$/, '')}.java`
              : undefined,
            isSeed: false, seedUris: [], wasDisassembled: false,
          };
          if (batch.classes.some((value) => value.id === clazz.id)) continue;
          batch.classes.push(clazz);
          classByArtifactAndName.set(`${artifact.id}\0${binaryName}`, clazz);
          if (!classByName.has(binaryName)) classByName.set(binaryName, clazz);
          artifact.classCount += 1;
          batch.relations.push(createJvmRelation(stageId, 'JvmArtifact', artifact.id,
            'JvmClass', clazz.id, 'CONTAINS_CLASS', artifact.classCount - 1));
        }
      } catch { errors += 1; }
  }

  const seeds = findExternalSeedClasses(input.lspBatch, artifactsByJar);
  for (const seed of seeds) {
    const clazz = classByArtifactAndName.get(`${seed.artifactId}\0${seed.binaryName}`);
    if (clazz) {
      clazz.isSeed = true;
      if (!clazz.seedUris.includes(seed.uri)) clazz.seedUris.push(seed.uri);
    }
  }
  const seedNames = [...new Set(seeds.map((value) => value.binaryName))]
    .filter((name) => classByName.has(name));
  const queue = configuredMaximum === undefined
    ? [...seedNames, ...[...classByName.keys()].filter((name) => !seedNames.includes(name))]
    : seedNames;
  const visited = new Set<string>();
  const classpathCache = path.join(
    input.cacheDirectory,
    'artifact-classpath',
  );
  const classpath = batch.artifacts
    .map((value) => createSafeClasspathEntry(
      value.binaryJarPath ?? value.headerJarPath ?? value.classpathEntryPath, value.id, classpathCache,
    ))
    .join(path.delimiter);
  const javapExecutable = findJavapExecutable();
  let providerVersion: string | undefined;
  try { providerVersion = String((await execFileAsync(javapExecutable, ['-version'])).stdout).trim(); } catch { errors += 1; }

  while (queue.length > 0 && visited.size < maxClasses) {
    const names = queue.splice(0, Math.min(25, maxClasses - visited.size))
      .filter((name) => !visited.has(name));
    if (names.length === 0) continue;
    names.forEach((name) => visited.add(name));
    try {
      const { stdout } = await execFileAsync(javapExecutable, ['-classpath', classpath, '-p', '-s', '-c', ...names], {
        maxBuffer: 64 * 1024 * 1024,
      });
      const targets = parseJavapClassOutput(String(stdout), stageId, batch, classByName);
      for (const target of targets) if (classByName.has(target) && !visited.has(target)) queue.push(target);
    } catch (error) {
      errors += names.length;
      console.warn(`[stage:jvm-artifact-enrichment] javap failed for ${names.join(', ')}: ` +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const truncated = queue.length > 0;
  batch.runs.push({
    id: stageId, lspRunId: input.lspRunId,
    status: errors > 0 || classpathErrorCount > 0 || truncated ? 'partial' : 'complete', startedAt,
    completedAt: new Date().toISOString(), provider: 'javap', providerVersion,
    classpathProviders: [...new Set(input.artifacts.flatMap((value) => value.providerIds))],
    classpathResolutionJson: JSON.stringify(classpathAttempts), classpathErrorCount,
    artifactCount: batch.artifacts.length, classCount: batch.classes.length,
    methodCount: batch.methods.length, fieldCount: batch.fields.length,
    callSiteCount: batch.callSites.length, errorCount: errors, truncated,
  });
  return dedupeArtifactBatch(batch);
}

function parseJavapClassOutput(
  output: string,
  stageId: string,
  batch: JvmArtifactBatch,
  classByName: Map<string, JvmClass>,
): Set<string> {
  const targets = new Set<string>();
  let clazz: JvmClass | undefined;
  let pending: { declaration: string; method: boolean } | undefined;
  let currentMethod: JvmMethod | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const classMatch = trimmed.match(/^(.*?)\b(class|interface|enum|record)\s+([\w.$]+)(.*)\{$/);
    if (classMatch) {
      clazz = classByName.get(classMatch[3]);
      if (clazz) {
        clazz.kind = classMatch[2] as JvmClass['kind'];
        clazz.access = classMatch[1].trim() || undefined;
        clazz.wasDisassembled = true;
        const extendsMatch = classMatch[4].match(/\bextends\s+(.+?)(?:\s+implements\s+|\s+permits\s+|$)/);
        const interfaceMatch = classMatch[4].match(/\bimplements\s+(.+?)(?:\s+permits\s+|$)/);
        if (clazz.kind === 'interface') {
          clazz.superName = undefined;
          clazz.interfaces = extendsMatch?.[1]?.split(',').map((value) => value.trim()) ?? [];
          if (clazz.interfaces.includes('java.lang.annotation.Annotation')) clazz.kind = 'annotation';
        } else {
          clazz.superName = extendsMatch?.[1]?.trim();
          clazz.interfaces = interfaceMatch?.[1]?.split(',').map((value) => value.trim()) ?? [];
        }
        if (clazz.superName) appendClassRelation(
          batch, stageId, clazz, clazz.superName, 'BYTECODE_SUPERCLASS', classByName,
        );
        clazz.interfaces.forEach((name, index) => appendClassRelation(
          batch, stageId, clazz!, name, 'BYTECODE_INTERFACE', classByName, index,
        ));
      }
      pending = undefined; currentMethod = undefined;
      continue;
    }
    if (!clazz) continue;
    const instruction = line.match(/^\s*(\d+):\s+(invoke\w+)\s+.*?\/\/\s+(?:InterfaceMethod|Method)\s+(?:([\w/$]+)\.)?"?([\w$<>]+)"?:(\S+)/);
    if (instruction && currentMethod) {
      const owner = instruction[3]?.replaceAll('/', '.') ?? clazz.binaryName;
      const targetClass = classByName.get(owner);
      const targetMethod = targetClass
        ? ensureReferencedMethod(batch, stageId, targetClass, instruction[4], instruction[5], undefined, true)
        : undefined;
      const callSite = {
        id: compactId('jvm-callsite', stageId, currentMethod.id, instruction[1]), stageId,
        callerMethodId: currentMethod.id, bytecodeOffset: Number(instruction[1]), opcode: instruction[2],
        targetOwner: owner, targetName: instruction[4], targetDescriptor: instruction[5],
        status: targetMethod ? 'resolved' as const : targetClass ? 'unresolved' as const : 'external' as const,
      };
      batch.callSites.push(callSite);
      batch.relations.push(createJvmRelation(stageId, 'JvmMethod', currentMethod.id,
        'JvmCallSite', callSite.id, 'HAS_BYTECODE_CALLSITE', batch.callSites.length - 1));
      if (targetMethod) batch.relations.push(createJvmRelation(stageId, 'JvmCallSite', callSite.id,
        'JvmMethod', targetMethod.id, 'BYTECODE_RESOLVES_TO', 0, 'resolved'));
      targets.add(owner);
      continue;
    }
    if (/^(?:public|protected|private|static|final|abstract|native|synchronized|strictfp|transient|volatile|\w)[^=]*;$/.test(trimmed)
      && !trimmed.startsWith('descriptor:')) {
      pending = { declaration: trimmed, method: trimmed.includes('(') };
      currentMethod = undefined;
      continue;
    }
    const descriptor = trimmed.match(/^descriptor:\s+(\S+)/)?.[1];
    if (descriptor && pending) {
      if (pending.method) {
        const beforeParen = pending.declaration.slice(0, pending.declaration.indexOf('(')).trim();
        let name = beforeParen.slice(beforeParen.lastIndexOf(' ') + 1);
        if (name === clazz.simpleName || name === clazz.binaryName) name = '<init>';
        currentMethod = ensureReferencedMethod(batch, stageId, clazz, name, descriptor, pending.declaration, false);
      } else {
        const withoutSemi = pending.declaration.slice(0, -1).split('=')[0].trim();
        const name = withoutSemi.slice(withoutSemi.lastIndexOf(' ') + 1);
        const field: JvmField = {
          id: compactId('jvm-field', stageId, clazz.id, name, descriptor), stageId,
          classId: clazz.id, owner: clazz.binaryName, name, descriptor,
          declaration: pending.declaration, access: memberAccess(pending.declaration),
        };
        if (!batch.fields.some((value) => value.id === field.id)) {
          batch.fields.push(field);
          batch.relations.push(createJvmRelation(stageId, 'JvmClass', clazz.id,
            'JvmField', field.id, 'DECLARES_FIELD', batch.fields.length - 1));
        }
      }
      pending = undefined;
      continue;
    }
    if (trimmed === 'Code:' && currentMethod) { currentMethod.hasCode = true; continue; }
  }
  return targets;
}

function appendClassRelation(
  batch: JvmArtifactBatch,
  stageId: string,
  source: JvmClass,
  targetName: string,
  kind: 'BYTECODE_SUPERCLASS' | 'BYTECODE_INTERFACE',
  classByName: Map<string, JvmClass>,
  ordinal = 0,
): void {
  const target = classByName.get(targetName);
  if (!target) return;
  batch.relations.push(createJvmRelation(
    stageId, 'JvmClass', source.id, 'JvmClass', target.id, kind, ordinal, 'resolved',
  ));
}

function ensureReferencedMethod(
  batch: JvmArtifactBatch, stageId: string, clazz: JvmClass, name: string,
  descriptor: string, declaration?: string, placeholder = false,
): JvmMethod {
  const id = compactId('jvm-method', stageId, clazz.id, name, descriptor);
  const existing = batch.methods.find((value) => value.id === id);
  if (existing) {
    if (declaration) { existing.declaration = declaration; existing.access = memberAccess(declaration); existing.isExternalPlaceholder = false; }
    return existing;
  }
  const method: JvmMethod = {
    id, stageId, classId: clazz.id, owner: clazz.binaryName, name, descriptor,
    declaration, access: declaration ? memberAccess(declaration) : undefined,
    hasCode: false, isExternalPlaceholder: placeholder,
  };
  batch.methods.push(method);
  batch.relations.push(createJvmRelation(stageId, 'JvmClass', clazz.id,
    'JvmMethod', method.id, 'DECLARES_METHOD', batch.methods.length - 1));
  return method;
}

function findExternalSeedClasses(
  lsp: LspObservationBatch,
  byJar: Map<string, JvmArtifact>,
): Array<{ artifactId: string; binaryName: string; uri: string }> {
  const result = new Map<string, { artifactId: string; binaryName: string; uri: string }>();
  for (const value of [...lsp.occurrences.map((item) => item.uri), ...lsp.documents.map((item) => item.uri)]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/^jdt:\/\/contents\/([^/]+\.jar)\/([^?]+)\.java/);
    const artifact = match ? byJar.get(match[1]) : undefined;
    if (!match || !artifact) continue;
    const binaryName = decodeURIComponent(match[2]).replaceAll('/', '.');
    result.set(`${artifact.id}\0${binaryName}\0${value}`, { artifactId: artifact.id, binaryName, uri: value });
  }
  return [...result.values()];
}

async function listJarClassEntries(jarPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(findJarExecutable(), ['tf', jarPath], { maxBuffer: 64 * 1024 * 1024 });
  return String(stdout).split(/\r?\n/).filter(Boolean);
}

async function resolveSourceJar(
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
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'gitnexus-jvm-artifact-enrichment' },
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

function createSafeClasspathEntry(value: string, artifactId: string, cacheDirectory: string): string {
  if (!value.includes(path.delimiter)) return value;
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const safe = path.join(cacheDirectory, `${encodeURIComponent(artifactId)}.jar`);
  if (fs.existsSync(safe)) return safe;
  try {
    fs.symlinkSync(value, safe);
  } catch {
    fs.copyFileSync(value, safe);
  }
  return safe;
}

function indexArtifactJarPaths(
  target: Map<string, JvmArtifact>,
  artifact: JvmArtifact,
  ...values: Array<string | undefined>
): void {
  for (const value of values) if (value) target.set(path.basename(value), artifact);
}

function createJvmRelation(
  stageId: string, sourceKind: JvmEntityKind, sourceId: string,
  targetKind: JvmEntityKind, targetId: string, kind: JvmRelation['kind'],
  ordinal: number, status: JvmRelation['status'] = 'observed',
): JvmRelation {
  return { id: compactId('jvm-relation', stageId, kind, sourceId, targetId, String(ordinal)),
    sourceKind, sourceId, targetKind, targetId, kind, stageId, status, ordinal };
}

function findJavapExecutable(): string {
  const configured = process.env.GITNEXUS_JDT_JAVA_HOME;
  return configured && fs.existsSync(path.join(configured, 'bin/javap')) ? path.join(configured, 'bin/javap') : 'javap';
}
function findJarExecutable(): string {
  const configured = process.env.GITNEXUS_JDT_JAVA_HOME;
  return configured && fs.existsSync(path.join(configured, 'bin/jar')) ? path.join(configured, 'bin/jar') : 'jar';
}
function memberAccess(value: string): string | undefined {
  return value.match(/^(public|protected|private)(?:\s|$)/)?.[1];
}
function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function compactId(kind: string, ...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return `${kind}:${hash.digest('hex')}`;
}
function dedupeArtifactBatch(batch: JvmArtifactBatch): JvmArtifactBatch {
  for (const key of Object.keys(batch) as Array<keyof JvmArtifactBatch>) {
    const values = batch[key] as Array<{ id: string }>;
    const unique = [...new Map(values.map((value) => [value.id, value])).values()];
    values.splice(0, values.length, ...unique);
  }
  return batch;
}
