import type { LspObservationBatch } from '../ingest/batch.js';
import type { ArtifactClasspathProviderAttempt, NormalizedArtifactDescriptor } from './classpath/index.js';
import {
  streamJvmArtifacts,
  type ArtifactEnrichmentProgress,
  type JvmArtifactStreamingSink,
} from './streaming-enrichment.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifact,
  type JvmArtifactBatch,
  type JvmArtifactEnrichmentRun,
  type JvmClass,
  type JvmMethod,
} from './model.js';
import { compactId, createJvmRelation } from './utils.js';

export type { ArtifactEnrichmentProgress } from './streaming-enrichment.js';
export {
  buildLspJvmClassBindings,
  compactId,
  createJvmRelation,
  findExternalSeedClasses,
  indexArtifactJarPaths,
  resolveSourceJar,
} from './utils.js';

export interface JvmArtifactEnrichmentInput {
  lspRunId: string;
  artifacts: NormalizedArtifactDescriptor[];
  cacheDirectory: string;
  classpathAttempts?: ArtifactClasspathProviderAttempt[];
  lspBatch: LspObservationBatch;
  maxDisassembledClasses?: number;
  workerConcurrency?: number;
  fetchSources?: boolean;
  onProgress?: (progress: ArtifactEnrichmentProgress) => void;
}

/** Compatibility collector; production streams directly to LadybugDB. */
export async function enrichJvmArtifacts(input: JvmArtifactEnrichmentInput): Promise<JvmArtifactBatch> {
  const sink = new CollectingArtifactSink();
  await streamJvmArtifacts({ ...input }, sink);
  return sink.finish();
}

class CollectingArtifactSink implements JvmArtifactStreamingSink {
  private readonly batch = emptyJvmArtifactBatch();

  async initialize(_run: JvmArtifactEnrichmentRun, metadata: JvmArtifactBatch): Promise<void> {
    mergeBatch(this.batch, metadata);
  }

  async write(batch: JvmArtifactBatch): Promise<void> {
    mergeBatch(this.batch, batch);
  }

  async completeArtifact(artifact: JvmArtifact): Promise<void> {
    const existing = this.batch.artifacts.find((value) => value.id === artifact.id);
    if (existing) Object.assign(existing, artifact);
    else this.batch.artifacts.push(artifact);
  }

  async resolveClassArtifacts(binaryNames: string[]): Promise<Map<string, string>> {
    const artifacts = new Map(this.batch.artifacts.map((value) => [value.id, value]));
    const wanted = new Set(binaryNames);
    const result = new Map<string, { artifactId: string; ordinal: number }>();
    for (const resolution of this.batch.resolutions) {
      if (!wanted.has(resolution.binaryName)) continue;
      const ordinal = artifacts.get(resolution.artifactId)?.classpathOrdinal ?? Number.MAX_SAFE_INTEGER;
      const current = result.get(resolution.binaryName);
      if (!current || ordinal < current.ordinal) result.set(
        resolution.binaryName, { artifactId: resolution.artifactId, ordinal },
      );
    }
    return new Map([...result].map(([name, value]) => [name, value.artifactId]));
  }

  async finalize(run: JvmArtifactEnrichmentRun, _lspBatch: LspObservationBatch): Promise<void> {
    this.batch.runs.length = 0;
    this.batch.runs.push(run);
    finalizeInMemoryRelations(this.batch, run.id);
  }

  finish(): JvmArtifactBatch {
    dedupeBatch(this.batch);
    return this.batch;
  }
}

function finalizeInMemoryRelations(batch: JvmArtifactBatch, stageId: string): void {
  const artifacts = new Map(batch.artifacts.map((value) => [value.id, value]));
  const canonical = new Map<string, JvmClass>();
  for (const clazz of [...batch.classes].sort((left, right) => {
    const leftOrdinal = artifacts.get(left.artifactId)?.classpathOrdinal ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = artifacts.get(right.artifactId)?.classpathOrdinal ?? Number.MAX_SAFE_INTEGER;
    return leftOrdinal - rightOrdinal || left.binaryName.localeCompare(right.binaryName);
  })) if (!canonical.has(clazz.binaryName)) canonical.set(clazz.binaryName, clazz);

  batch.resolutions.length = 0;
  for (const [binaryName, clazz] of canonical) {
    const artifact = artifacts.get(clazz.artifactId)!;
    batch.resolutions.push({
      binaryName, stageId, classId: clazz.id, artifactId: clazz.artifactId,
      classpathOrdinal: artifact.classpathOrdinal,
    });
  }
  for (const clazz of batch.classes) {
    if (clazz.superName) appendClassRelation(
      batch, stageId, clazz, clazz.superName, canonical, 0, 'BYTECODE_SUPERCLASS',
    );
    clazz.interfaces.forEach((name, ordinal) => appendClassRelation(
      batch, stageId, clazz, name, canonical, ordinal, 'BYTECODE_INTERFACE',
    ));
  }
  for (const call of batch.callSites) {
    const targetClass = canonical.get(call.targetOwner);
    if (!targetClass) { call.status = 'external'; continue; }
    const target = ensureMethod(batch, stageId, targetClass, call.targetName, call.targetDescriptor, true);
    call.status = 'resolved';
    batch.relations.push(createJvmRelation(
      stageId, 'JvmCallSite', call.id, 'JvmMethod', target.id,
      'BYTECODE_RESOLVES_TO', 0, 'resolved',
    ));
  }
}

function appendClassRelation(
  batch: JvmArtifactBatch,
  stageId: string,
  source: JvmClass,
  targetName: string,
  canonical: Map<string, JvmClass>,
  ordinal: number,
  kind: 'BYTECODE_SUPERCLASS' | 'BYTECODE_INTERFACE',
): void {
  const target = canonical.get(targetName);
  if (!target) return;
  batch.relations.push(createJvmRelation(
    stageId, 'JvmClass', source.id, 'JvmClass', target.id, kind, ordinal, 'resolved',
  ));
}

function ensureMethod(
  batch: JvmArtifactBatch,
  stageId: string,
  clazz: JvmClass,
  name: string,
  descriptor: string,
  placeholder: boolean,
): JvmMethod {
  const id = compactId('jvm-method', stageId, clazz.id, name, descriptor);
  const existing = batch.methods.find((value) => value.id === id);
  if (existing) return existing;
  const method: JvmMethod = {
    id, stageId, classId: clazz.id, owner: clazz.binaryName, name, descriptor,
    hasCode: false, isExternalPlaceholder: placeholder, annotations: [], annotationValuesJson: '{}',
    codeOrigin: clazz.codeOrigin,
  };
  batch.methods.push(method);
  batch.relations.push(createJvmRelation(
    stageId, 'JvmClass', clazz.id, 'JvmMethod', method.id,
    'DECLARES_METHOD', batch.methods.length - 1,
  ));
  return method;
}

function mergeBatch(target: JvmArtifactBatch, source: JvmArtifactBatch): void {
  target.runs.push(...source.runs);
  target.artifacts.push(...source.artifacts);
  target.resolutions.push(...source.resolutions);
  target.binaryReferences.push(...source.binaryReferences);
  target.binaryReferenceRelations.push(...source.binaryReferenceRelations);
  target.classes.push(...source.classes);
  target.methods.push(...source.methods);
  target.fields.push(...source.fields);
  target.callSites.push(...source.callSites);
  target.relations.push(...source.relations);
  target.bindings.push(...source.bindings);
}

function dedupeBatch(batch: JvmArtifactBatch): void {
  for (const key of Object.keys(batch) as Array<keyof JvmArtifactBatch>) {
    const values = batch[key] as Array<{ id?: string; binaryName?: string }>;
    const unique = new Map<string, typeof values[number]>();
    for (const value of values) unique.set(value.id ?? value.binaryName!, value);
    values.length = 0;
    appendInChunks(values, [...unique.values()]);
  }
}

function appendInChunks<T>(target: T[], values: T[], size = 10_000): void {
  for (let offset = 0; offset < values.length; offset += size) {
    target.push(...values.slice(offset, offset + size));
  }
}
