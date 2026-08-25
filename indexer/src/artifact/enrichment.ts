import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { globSync } from 'glob';
import type { LspObservationBatch } from '../ingest/batch.js';
import { stableId } from '../ingest/builders.js';
import { symbolNodeTable } from '../model.js';
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
import {
  disassembleClassQueue,
  normalizeJarClassEntries,
  type JavapDisassemblyProgress,
} from './disassembly.js';

const execFileAsync = promisify(execFile);

export interface JvmArtifactEnrichmentInput {
  lspRunId: string;
  artifacts: NormalizedArtifactDescriptor[];
  cacheDirectory: string;
  classpathAttempts?: ArtifactClasspathProviderAttempt[];
  lspBatch: LspObservationBatch;
  maxDisassembledClasses?: number;
  javapConcurrency?: number;
  fetchSources?: boolean;
  onProgress?: (progress: JavapDisassemblyProgress) => void;
}

export async function enrichJvmArtifacts(input: JvmArtifactEnrichmentInput): Promise<JvmArtifactBatch> {
  const batch = emptyJvmArtifactBatch();
  const startedAt = new Date().toISOString();
  const stageId = stableId('jvm-artifact-stage', input.lspRunId);
  const configuredMaximum = input.maxDisassembledClasses
    ?? positiveInteger(process.env.GITNEXUS_JVM_MAX_CLASSES);
  const maxClasses = configuredMaximum ?? Number.POSITIVE_INFINITY;
  const javapConcurrency = input.javapConcurrency
    ?? positiveInteger(process.env.GITNEXUS_JVM_CONCURRENCY)
    ?? 4;
  const fetchSources = input.fetchSources ?? process.env.GITNEXUS_JVM_FETCH_SOURCES !== '0';
  const classpathAttempts = input.classpathAttempts ?? [];
  const classpathErrorCount = classpathAttempts.filter((value) => value.status === 'failed').length;
  let errors = 0;
  const javapExecutable = findJavapExecutable();
  let providerVersion: string | undefined;
  try { providerVersion = String((await execFileAsync(javapExecutable, ['-version'])).stdout).trim(); } catch { errors += 1; }
  const runtimeMajor = javaMajorFromVersion(providerVersion);

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
        indexArtifactJarPaths(
          artifactsByJar, existingArtifact, ...(descriptor.classpathEntryAliases ?? []),
        );
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
      indexArtifactJarPaths(artifactsByJar, artifact, ...(descriptor.classpathEntryAliases ?? []));
      batch.relations.push(createJvmRelation(stageId, 'JvmArtifactEnrichmentRun', stageId,
        'JvmArtifact', artifact.id, 'HAS_ARTIFACT', batch.artifacts.length - 1));

      try {
        const entries = normalizeJarClassEntries(await listJarClassEntries(crawlJarPath), runtimeMajor);
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
            isSeed: false, seedUris: [], wasDisassembled: false, annotations: [],
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
  const classpathCache = path.join(
    input.cacheDirectory,
    'artifact-classpath',
  );
  const classpath = batch.artifacts
    .map((value) => createSafeClasspathEntry(
      value.binaryJarPath ?? value.headerJarPath ?? value.classpathEntryPath, value.id, classpathCache,
    ))
    .join(path.delimiter);
  const reportProgress = input.onProgress ?? logDisassemblyProgress;
  const disassembly = await disassembleClassQueue({
    initialNames: queue,
    maxClasses,
    concurrency: javapConcurrency,
    executeBatch: async (names) => {
      const { stdout } = await execFileAsync(
        javapExecutable,
        ['-classpath', classpath, '-v', '-p', '-s', '-c', ...names],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return String(stdout);
    },
    consumeOutput: (output) => [...parseJavapClassOutput(output, stageId, batch, classByName)]
      .filter((target) => classByName.has(target)),
    onBatchFailure: (names, error) => {
      errors += names.length;
      console.warn(
        `[stage:jvm-artifact-enrichment] javap failed for ${names.length} classes `
        + `(${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}): ${conciseError(error)}`,
      );
    },
    onProgress: reportProgress,
  });

  const truncated = disassembly.truncated;
  const disassembledCount = batch.classes.filter((value) => value.wasDisassembled).length;
  if (batch.classes.length > 0 && (disassembledCount === 0 || batch.methods.length === 0)) {
    errors += 1;
    console.warn(
      '[stage:jvm-artifact-enrichment] integrity check failed: javap produced no parsed members',
    );
  }
  appendInChunks(batch.bindings, buildLspJvmBindings(
    input.lspBatch, stageId, artifactsByJar, classByArtifactAndName, batch.methods,
  ));
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

/** Avoid V8's argument-count limit when a monorepo produces hundreds of thousands of bindings. */
function appendInChunks<T>(target: T[], values: T[], chunkSize = 10_000): void {
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    target.push(...values.slice(offset, offset + chunkSize));
  }
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
  let currentField: JvmField | undefined;
  let inClassBody = false;
  let annotationTarget: JvmClass | JvmMethod | JvmField | undefined;
  let annotationIndent = -1;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    const classMatch = trimmed.match(/^(.*?)\b(class|interface|enum|record)\s+([\w.$]+)(.*?)(?:\s*\{)?$/);
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
      inClassBody = trimmed.endsWith('{');
      pending = undefined; currentMethod = undefined; currentField = undefined;
      annotationTarget = undefined; annotationIndent = -1;
      continue;
    }
    if (!clazz) continue;
    if (trimmed === '{') { inClassBody = true; continue; }
    if (trimmed === '}') {
      inClassBody = false; pending = undefined; currentMethod = undefined; currentField = undefined;
      annotationTarget = undefined; annotationIndent = -1;
      continue;
    }
    if (/^Runtime(?:Visible|Invisible)Annotations:$/.test(trimmed)) {
      annotationTarget = indent > 0 ? currentMethod ?? currentField ?? clazz : clazz;
      annotationIndent = indent;
      continue;
    }
    if (annotationTarget && indent > annotationIndent) {
      const annotation = trimmed.match(/^([A-Za-z_$][\w.$]*)(?:\(|$)/)?.[1];
      if (annotation && !/^(?:descriptor|flags|Code|Deprecated)$/.test(annotation)) {
        if (!annotationTarget.annotations.includes(annotation)) annotationTarget.annotations.push(annotation);
      }
    } else if (annotationTarget && trimmed) {
      annotationTarget = undefined; annotationIndent = -1;
    }
    if (!inClassBody) continue;
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
      currentMethod = undefined; currentField = undefined;
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
          declaration: pending.declaration, access: memberAccess(pending.declaration), annotations: [],
        };
        const existingField = batch.fields.find((value) => value.id === field.id);
        if (!existingField) {
          batch.fields.push(field);
          batch.relations.push(createJvmRelation(stageId, 'JvmClass', clazz.id,
            'JvmField', field.id, 'DECLARES_FIELD', batch.fields.length - 1));
        }
        currentField = existingField ?? field;
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
    annotations: [],
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
  const values = [
    ...lsp.occurrences.map((item) => item.uri), ...lsp.documents.map((item) => item.uri),
    ...lsp.symbols.map((item) => item.uri), ...lsp.hovers.map((item) => item.contents),
  ];
  for (const value of values) {
    for (const reference of resolveJdtReferences(value, byJar)) {
      result.set(
        `${reference.artifactId}\0${reference.binaryName}\0${reference.uri}`,
        reference,
      );
    }
  }
  return [...result.values()];
}

function buildLspJvmBindings(
  lsp: LspObservationBatch,
  stageId: string,
  byJar: Map<string, JvmArtifact>,
  classByArtifactAndName: Map<string, JvmClass>,
  methods: JvmMethod[],
): JvmArtifactBatch['bindings'] {
  const bindings: JvmArtifactBatch['bindings'] = [];
  const methodsByClassAndName = new Map<string, JvmMethod[]>();
  for (const method of methods) {
    const key = `${method.classId}\0${method.name}`;
    methodsByClassAndName.set(key, [...(methodsByClassAndName.get(key) ?? []), method]);
  }
  const append = (
    sourceKind: JvmArtifactBatch['bindings'][number]['sourceKind'], sourceId: string,
    value: string, kind: JvmArtifactBatch['bindings'][number]['kind'], memberName?: string,
  ) => {
    if (!sourceId) return;
    for (const reference of resolveJdtReferences(value, byJar)) {
      const clazz = classByArtifactAndName.get(`${reference.artifactId}\0${reference.binaryName}`);
      if (!clazz) continue;
      bindings.push({
        id: compactId('lsp-jvm-binding', stageId, sourceId, clazz.id, kind),
        sourceKind, sourceId, targetKind: 'JvmClass', targetId: clazz.id, kind, stageId,
        status: 'resolved', confidence: 1,
        reason: 'JDT dependency URI resolved to class in normalized artifact',
      });
      if (!memberName) continue;
      const candidates = methodsByClassAndName.get(`${clazz.id}\0${memberName}`) ?? [];
      if (candidates.length !== 1) continue;
      const method = candidates[0]!;
      bindings.push({
        id: compactId('lsp-jvm-binding', stageId, sourceId, method.id, 'SYMBOL_IDENTITY'),
        sourceKind, sourceId, targetKind: 'JvmMethod', targetId: method.id,
        kind: 'SYMBOL_IDENTITY', stageId, status: 'resolved', confidence: 0.95,
        reason: 'Unique JVM method with the LSP-resolved owner and member name',
      });
    }
  };
  for (const symbol of lsp.symbols) {
    const isType = ['Class', 'Interface', 'Enum', 'Struct'].includes(symbol.kindName);
    append(
      symbolNodeTable(symbol.kindName), symbol.id, symbol.uri,
      isType ? 'SYMBOL_IDENTITY' : 'SYMBOL_OWNER',
      isType ? undefined : symbol.name.split('(')[0]?.trim(),
    );
  }
  for (const hover of lsp.hovers) append('LspHover', hover.id, hover.contents, 'HOVER_TARGET');
  for (const occurrence of lsp.occurrences) {
    append('LspOccurrence', occurrence.id, occurrence.uri, 'OCCURRENCE_TARGET');
  }
  return bindings;
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
function javaMajorFromVersion(value: string | undefined): number | undefined {
  const match = value?.match(/^(?:javap\s+)?(?:(?:1\.)?(\d+))/i);
  return match ? Number(match[1]) : undefined;
}
function conciseError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail = typeof stderr === 'string' || Buffer.isBuffer(stderr)
    ? String(stderr).trim().split(/\r?\n/).find(Boolean)
    : undefined;
  const message = detail ?? (error instanceof Error ? error.name : String(error));
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}
function logDisassemblyProgress(progress: JavapDisassemblyProgress): void {
  const elapsedSeconds = Math.max(progress.elapsedMs / 1_000, 0.001);
  const rate = progress.completedClasses / elapsedSeconds;
  console.log(
    `[stage:jvm-artifact-enrichment] disassembly ${progress.done ? 'complete' : 'progress'}: `
    + `${progress.completedClasses}/${progress.totalClasses} classes, `
    + `${progress.failedClasses} failed, ${rate.toFixed(1)} classes/s, `
    + `concurrency=${progress.concurrency}`,
  );
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
    values.length = 0;
    appendInChunks(values, unique);
  }
  return batch;
}
