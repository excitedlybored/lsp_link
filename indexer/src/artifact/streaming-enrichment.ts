import fs from 'node:fs';
import path from 'node:path';
import type { LspObservationBatch } from '../ingest/batch.js';
import { stableId } from '../ingest/builders.js';
import {
  inferMavenCoordinate,
  type ArtifactClasspathProviderAttempt,
  type NormalizedArtifactDescriptor,
} from './classpath/index.js';
import {
  buildLspJvmClassBindings,
  compactId,
  createJvmRelation,
  findExternalSeedClasses,
  findLspJvmMethodBindingRequests,
  indexArtifactJarPaths,
  resolveSourceJar,
} from './utils.js';
import {
  AsmArtifactWorker,
  AsmArtifactAnalysisError,
  AsmWorkerProcessError,
  type AsmFact,
  type AsmFactBatch,
  type AsmWorkerInfo,
} from './asm-worker.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifact,
  type JvmArtifactBatch,
  type JvmArtifactEnrichmentRun,
  type JvmArtifactEnrichmentSummary,
} from './model.js';
import { createHash } from 'node:crypto';

export interface StreamingJvmArtifactEnrichmentInput {
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

export interface ArtifactEnrichmentProgress {
  completedClasses: number;
  totalClasses: number;
  successfulClasses: number;
  failedClasses: number;
  concurrency: number;
  elapsedMs: number;
  done: boolean;
}

export interface JvmArtifactStreamingSink {
  initialize(run: JvmArtifactEnrichmentRun, artifacts: JvmArtifactBatch): Promise<void>;
  beginArtifactAttempt?(artifactId: string): Promise<void>;
  rollbackArtifactAttempt?(artifactId: string): Promise<void>;
  write(batch: JvmArtifactBatch, artifactId?: string): Promise<void>;
  completeArtifact(artifact: JvmArtifact): Promise<void>;
  resolveClassArtifacts(binaryNames: string[]): Promise<Map<string, string>>;
  finalize(run: JvmArtifactEnrichmentRun, lspBatch: LspObservationBatch): Promise<void>;
}

/** Stream bounded ASM facts to a durable sink without constructing a repository-wide graph batch. */
export async function streamJvmArtifacts(
  input: StreamingJvmArtifactEnrichmentInput,
  sink: JvmArtifactStreamingSink,
  completedArtifactIds: ReadonlySet<string> = new Set(),
): Promise<JvmArtifactEnrichmentSummary> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const stageId = stableId('jvm-artifact-stage', input.lspRunId);
  const configuredMaximum = input.maxDisassembledClasses
    ?? positiveInteger(process.env.GITNEXUS_JVM_MAX_CLASSES);
  const concurrency = Math.min(16, input.workerConcurrency
    ?? positiveInteger(process.env.GITNEXUS_JVM_CONCURRENCY) ?? 4);
  const fetchSources = input.fetchSources ?? process.env.GITNEXUS_JVM_FETCH_SOURCES !== '0';
  const attempts = input.classpathAttempts ?? [];
  const classpathErrorCount = attempts.filter((value) => value.status === 'failed').length;
  const artifactsByJar = new Map<string, JvmArtifact>();
  const jarPaths = new Map<string, string>();
  const metadata = emptyJvmArtifactBatch();

  for (const [classpathOrdinal, descriptor] of input.artifacts.entries()) {
    const classpathEntryPath = path.resolve(descriptor.classpathEntryPath);
    const headerJarPath = descriptor.headerJarPath ? path.resolve(descriptor.headerJarPath) : undefined;
    const binaryJarPath = descriptor.binaryJarPath ? path.resolve(descriptor.binaryJarPath) : undefined;
    const crawlJarPath = binaryJarPath ?? headerJarPath ?? classpathEntryPath;
    if (!fs.existsSync(crawlJarPath)) continue;
    const coordinate = descriptor.coordinate ?? inferMavenCoordinate(crawlJarPath);
    const artifactId = compactId(
      'jvm-artifact', stageId, coordinate ?? crawlJarPath,
      path.basename(crawlJarPath).replace(/^(?:header_|processed_)/, ''),
    );
    const existing = metadata.artifacts.find((value) => value.id === artifactId);
    if (existing) {
      if (!existing.buildRootIds.includes(descriptor.buildRootId)) existing.buildRootIds.push(descriptor.buildRootId);
      existing.classpathProviders = [...new Set([...existing.classpathProviders, ...descriptor.providerIds])];
      existing.classpathScopes = [...new Set([...existing.classpathScopes, descriptor.scope])];
      existing.modulePath ||= descriptor.modulePath;
      existing.classpathOrdinal = Math.min(existing.classpathOrdinal, classpathOrdinal);
      indexArtifactJarPaths(artifactsByJar, existing, classpathEntryPath, headerJarPath, binaryJarPath,
        ...(descriptor.classpathEntryAliases ?? []));
      continue;
    }
    const source = descriptor.sourceJarPath
      ? { path: path.resolve(descriptor.sourceJarPath), origin: 'provided' as const }
      : await resolveSourceJar(crawlJarPath, input.cacheDirectory, fetchSources);
    const artifact: JvmArtifact = {
      id: artifactId, stageId, buildRootIds: [descriptor.buildRootId],
      classpathProviders: [...descriptor.providerIds], classpathScopes: [descriptor.scope],
      modulePath: descriptor.modulePath, coordinate, classpathEntryPath,
      headerJarPath, binaryJarPath, sourceJarPath: source.path, sourceOrigin: source.origin,
      associationStatus: source.path && binaryJarPath ? 'complete' : binaryJarPath ? 'binary_only' : 'header_only',
      classCount: 0, methodCount: 0, fieldCount: 0, callSiteCount: 0,
      contentHash: hashFile(crawlJarPath), classpathOrdinal,
      codeOrigin: descriptor.codeOrigin ?? 'unknown',
      processingStatus: 'pending', errorCount: 0,
    };
    metadata.artifacts.push(artifact);
    jarPaths.set(artifact.id, crawlJarPath);
    indexArtifactJarPaths(artifactsByJar, artifact, classpathEntryPath, headerJarPath, binaryJarPath,
      ...(descriptor.classpathEntryAliases ?? []));
    metadata.relations.push(createJvmRelation(
      stageId, 'JvmArtifactEnrichmentRun', stageId, 'JvmArtifact', artifact.id,
      'HAS_ARTIFACT', metadata.artifacts.length - 1,
    ));
  }

  const run: JvmArtifactEnrichmentRun = {
    id: stageId, lspRunId: input.lspRunId, status: 'running', startedAt,
    provider: 'asm', classpathProviders: [...new Set(input.artifacts.flatMap((value) => value.providerIds))],
    classpathResolutionJson: JSON.stringify(attempts), classpathErrorCount,
    artifactCount: metadata.artifacts.length, classCount: 0, methodCount: 0,
    fieldCount: 0, callSiteCount: 0, errorCount: classpathErrorCount, truncated: false,
  };
  metadata.runs.push(run);
  const initialization = {
    ...metadata,
    artifacts: metadata.artifacts.filter((artifact) => !completedArtifactIds.has(artifact.id)),
  };
  await sink.initialize(run, initialization);

  const seeds = findExternalSeedClasses(input.lspBatch, artifactsByJar);
  const methodBindingRequests = findLspJvmMethodBindingRequests(
    input.lspBatch, stageId, artifactsByJar,
  );
  const requestedMethodKeys = new Set(
    methodBindingRequests.map((value) => `${value.classId}\0${value.memberName}`),
  );
  const requestedMethodCandidates = new Map<string, Set<string>>();
  const seedUris = new Map<string, string[]>();
  for (const seed of seeds) {
    const key = `${seed.artifactId}\0${seed.binaryName}`;
    seedUris.set(key, [...new Set([...(seedUris.get(key) ?? []), seed.uri])]);
  }
  const selectedByArtifact = new Map<string, string[]>();
  if (configuredMaximum !== undefined) {
    const unique = new Set<string>();
    for (const seed of seeds) {
      const key = `${seed.artifactId}\0${seed.binaryName}`;
      if (unique.has(key) || unique.size >= configuredMaximum) continue;
      unique.add(key);
      selectedByArtifact.set(seed.artifactId, [
        ...(selectedByArtifact.get(seed.artifactId) ?? []), seed.binaryName,
      ]);
    }
  }

  let writeChain = Promise.resolve();
  let completedClasses = 0;
  const discoveredCallTargets = new Set<string>();
  let worker = new AsmArtifactWorker(concurrency);
  let restartAvailable = true;
  let workerInfo: AsmWorkerInfo;
  try {
    workerInfo = await worker.start();
  } catch (error) {
    if (!(error instanceof AsmWorkerProcessError) || !restartAvailable) throw error;
    restartAvailable = false;
    worker = new AsmArtifactWorker(concurrency);
    workerInfo = await worker.start();
  }
  run.providerVersion = workerInfo.providerVersion;
  const processOne = async (
    worker: AsmArtifactWorker,
    info: AsmWorkerInfo,
    artifact: JvmArtifact,
    selectedClasses: string[],
    emitClassFacts: boolean,
    finishArtifact: boolean,
  ): Promise<JvmArtifact> => {
      const countSnapshot = {
        classCount: artifact.classCount, methodCount: artifact.methodCount,
        fieldCount: artifact.fieldCount, callSiteCount: artifact.callSiteCount,
      };
      try {
      artifact.processingStatus = 'running';
      writeChain = writeChain.then(() => sink.completeArtifact(artifact));
      await writeChain;
      await sink.beginArtifactAttempt?.(artifact.id);
      const result = await worker.analyzeArtifact({
        artifactId: artifact.id,
        jarPath: jarPaths.get(artifact.id)!,
        contentHash: artifact.contentHash,
        classpathOrdinal: artifact.classpathOrdinal,
        runtimeMajor: info.runtimeMajor,
        selectedClasses,
        analyzeAll: configuredMaximum === undefined,
        emitClassFacts,
      }, (workerBatch) => {
        writeChain = writeChain.then(async () => {
          const normalized = normalizeBatch(
            workerBatch, stageId, artifact, seedUris,
            requestedMethodKeys, requestedMethodCandidates,
            discoveredCallTargets,
          );
          run.classCount += normalized.classes.length;
          run.methodCount += normalized.methods.length;
          run.fieldCount += normalized.fields.length;
          run.callSiteCount += normalized.callSites.length;
          artifact.classCount += normalized.classes.length;
          artifact.methodCount += normalized.methods.length;
          artifact.fieldCount += normalized.fields.length;
          artifact.callSiteCount += normalized.callSites.length;
          await sink.write(normalized, artifact.id);
        });
        return writeChain;
      });
      await writeChain;
      artifact.errorCount += result.errorCount;
      run.errorCount += result.errorCount;
      if (emitClassFacts) completedClasses += result.classCount;
      if (finishArtifact) {
        artifact.processingStatus = artifact.errorCount > 0 ? 'partial' : 'complete';
        artifact.completedAt = new Date().toISOString();
        writeChain = writeChain.then(() => sink.completeArtifact(artifact));
        await writeChain;
      }
      input.onProgress?.({
        completedClasses, totalClasses: Math.max(completedClasses, run.classCount),
        successfulClasses: completedClasses - run.errorCount,
        failedClasses: run.errorCount, concurrency,
        elapsedMs: Date.now() - startedMs, done: false,
      });
      return artifact;
      } catch (error) {
        // A worker can exit after one or more batches were durably spooled.
        // Roll the current attempt back before the one-time replay so COPY
        // never sees duplicate deterministic IDs. Other sinks remain safe via
        // their existing idempotent MERGE behavior.
        await writeChain.catch(() => undefined);
        await sink.rollbackArtifactAttempt?.(artifact.id);
        run.classCount -= artifact.classCount - countSnapshot.classCount;
        run.methodCount -= artifact.methodCount - countSnapshot.methodCount;
        run.fieldCount -= artifact.fieldCount - countSnapshot.fieldCount;
        run.callSiteCount -= artifact.callSiteCount - countSnapshot.callSiteCount;
        Object.assign(artifact, countSnapshot);
        throw error;
      }
  };
  const processAttempt = async (
    artifacts: JvmArtifact[],
    allowRestart: boolean,
    selections: Map<string, string[]>,
    emitClassFacts: boolean,
    finishArtifacts: boolean,
  ): Promise<void> => {
    if (artifacts.length === 0) return;
    const settled = await Promise.allSettled(
      artifacts.map((artifact) => processOne(
        worker, workerInfo, artifact, selections.get(artifact.id) ?? [], emitClassFacts, finishArtifacts,
      )),
    );
    const restart: JvmArtifact[] = [];
    let unexpectedError: unknown;
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') continue;
      const artifact = artifacts[index]!;
      if (result.reason instanceof AsmWorkerProcessError) {
        restart.push(artifact);
        continue;
      }
      if (!(result.reason instanceof AsmArtifactAnalysisError)) {
        unexpectedError ??= result.reason;
        continue;
      }
      artifact.processingStatus = 'failed';
      artifact.errorCount += 1;
      artifact.completedAt = new Date().toISOString();
      run.errorCount += 1;
      writeChain = writeChain.then(() => sink.completeArtifact(artifact));
      await writeChain;
    }
    if (unexpectedError) {
      await worker.close();
      throw unexpectedError;
    }
    if (restart.length > 0) {
      if (!allowRestart || !restartAvailable) {
        throw new Error(`ASM worker failed again while processing ${restart.length} artifacts`);
      }
      restartAvailable = false;
      await worker.close();
      worker = new AsmArtifactWorker(concurrency);
      workerInfo = await worker.start();
      run.providerVersion = workerInfo.providerVersion;
      await processAttempt(restart, false, selections, emitClassFacts, finishArtifacts);
    }
  };

  await processAttempt(
    metadata.artifacts.filter((artifact) => !completedArtifactIds.has(artifact.id)),
    true,
    selectedByArtifact,
    true,
    configuredMaximum === undefined,
  );
  let traversalTruncated = false;
  if (configuredMaximum !== undefined) {
    const scheduled = new Set<string>();
    for (const [artifactId, names] of selectedByArtifact) {
      for (const name of names) scheduled.add(`${artifactId}\0${name}`);
    }
    while (discoveredCallTargets.size > 0 && scheduled.size < configuredMaximum) {
      const targets = [...discoveredCallTargets];
      discoveredCallTargets.clear();
      const resolved = await sink.resolveClassArtifacts(targets);
      const selections = new Map<string, string[]>();
      for (const binaryName of targets) {
        const artifactId = resolved.get(binaryName);
        if (!artifactId) continue;
        const key = `${artifactId}\0${binaryName}`;
        if (scheduled.has(key)) continue;
        if (scheduled.size >= configuredMaximum) { traversalTruncated = true; break; }
        scheduled.add(key);
        selections.set(artifactId, [...(selections.get(artifactId) ?? []), binaryName]);
      }
      const selectedArtifacts = metadata.artifacts.filter((artifact) => selections.has(artifact.id));
      if (selectedArtifacts.length === 0) break;
      await processAttempt(selectedArtifacts, true, selections, false, false);
    }
    if (discoveredCallTargets.size > 0 && scheduled.size >= configuredMaximum) traversalTruncated = true;
    for (const artifact of metadata.artifacts.filter((value) => !completedArtifactIds.has(value.id))) {
      artifact.processingStatus = artifact.errorCount > 0 ? 'partial' : 'complete';
      artifact.completedAt = new Date().toISOString();
      writeChain = writeChain.then(() => sink.completeArtifact(artifact));
    }
    await writeChain;
  }
  await worker.close();
  try {
    run.truncated = traversalTruncated;
    run.status = run.errorCount > 0 || run.truncated ? 'partial' : 'complete';
    run.completedAt = new Date().toISOString();
    const bindingBatch = emptyJvmArtifactBatch();
    bindingBatch.bindings.push(...buildLspJvmClassBindings(
      input.lspBatch, stageId, artifactsByJar,
    ));
    for (const request of methodBindingRequests) {
      const candidates = requestedMethodCandidates.get(`${request.classId}\0${request.memberName}`);
      if (candidates?.size !== 1) continue;
      const targetId = [...candidates][0]!;
      bindingBatch.bindings.push({
        id: compactId('lsp-jvm-binding', stageId, request.sourceId, targetId, 'SYMBOL_IDENTITY'),
        sourceKind: request.sourceKind, sourceId: request.sourceId,
        targetKind: 'JvmMethod', targetId, kind: 'SYMBOL_IDENTITY', stageId,
        status: 'resolved', confidence: 0.95,
        reason: 'Unique JVM method with the LSP-resolved owner and member name',
      });
    }
    await sink.write(bindingBatch);
    await sink.finalize(run, input.lspBatch);
    input.onProgress?.({
      completedClasses, totalClasses: run.classCount,
      successfulClasses: completedClasses - run.errorCount,
      failedClasses: run.errorCount, concurrency,
      elapsedMs: Date.now() - startedMs, done: true,
    });
    return {
      run,
      sourceAssociatedArtifactCount: metadata.artifacts
        .filter((value) => value.associationStatus === 'complete').length,
    };
  } catch (error) {
    run.status = 'failed';
    throw error;
  }
}

function normalizeBatch(
  workerBatch: AsmFactBatch,
  stageId: string,
  artifact: JvmArtifact,
  seedUris: Map<string, string[]>,
  requestedMethodKeys: ReadonlySet<string>,
  requestedMethodCandidates: Map<string, Set<string>>,
  discoveredCallTargets: Set<string>,
): JvmArtifactBatch {
  const batch = emptyJvmArtifactBatch();
  for (const fact of workerBatch.facts) normalizeFact(
    fact, stageId, artifact, seedUris, batch, requestedMethodKeys, requestedMethodCandidates,
    discoveredCallTargets,
  );
  return batch;
}

function normalizeFact(
  fact: AsmFact,
  stageId: string,
  artifact: JvmArtifact,
  seedUris: Map<string, string[]>,
  batch: JvmArtifactBatch,
  requestedMethodKeys: ReadonlySet<string>,
  requestedMethodCandidates: Map<string, Set<string>>,
  discoveredCallTargets: Set<string>,
): void {
  const classId = compactId('jvm-class', stageId, artifact.id,
    fact.factType === 'class' ? fact.binaryName : fact.owner);
  if (fact.factType === 'class') {
    const uris = seedUris.get(`${artifact.id}\0${fact.binaryName}`) ?? [];
    batch.classes.push({
      id: classId, stageId, artifactId: artifact.id, binaryName: fact.binaryName,
      packageName: fact.binaryName.includes('.') ? fact.binaryName.slice(0, fact.binaryName.lastIndexOf('.')) : '',
      simpleName: fact.binaryName.slice(fact.binaryName.lastIndexOf('.') + 1),
      kind: fact.kind, access: fact.access || undefined, superName: fact.superName ?? undefined,
      interfaces: [...fact.interfaces],
      sourceEntry: artifact.sourceJarPath
        ? `${fact.binaryName.replaceAll('.', '/').replace(/\$.*$/, '')}.java` : undefined,
      isSeed: uris.length > 0, seedUris: uris, wasDisassembled: fact.detailed,
      annotations: [...fact.annotations], codeOrigin: artifact.codeOrigin,
    });
    batch.resolutions.push({
      binaryName: fact.binaryName, stageId, classId, artifactId: artifact.id,
      classpathOrdinal: artifact.classpathOrdinal,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmArtifact', artifact.id, 'JvmClass', classId,
      'CONTAINS_CLASS', artifact.classCount + batch.classes.length - 1,
    ));
    if (fact.superName) appendBinaryReference(
      batch, stageId, fact.superName, 'JvmClass', classId, 'SUPERCLASS_TARGET', 0,
    );
    fact.interfaces.forEach((name, ordinal) => appendBinaryReference(
      batch, stageId, name, 'JvmClass', classId, 'INTERFACE_TARGET', ordinal,
    ));
    return;
  }
  if (fact.factType === 'method') {
    const id = compactId('jvm-method', stageId, classId, fact.name, fact.descriptor);
    const requestKey = `${classId}\0${fact.name}`;
    if (requestedMethodKeys.has(requestKey)) {
      const candidates = requestedMethodCandidates.get(requestKey) ?? new Set<string>();
      candidates.add(id);
      requestedMethodCandidates.set(requestKey, candidates);
    }
    batch.methods.push({
      id, stageId, classId, owner: fact.owner, name: fact.name, descriptor: fact.descriptor,
      declaration: `${fact.access ? `${fact.access} ` : ''}${fact.name}${fact.descriptor}`,
      access: fact.access || undefined, hasCode: fact.hasCode,
      isExternalPlaceholder: false, annotations: [...fact.annotations], codeOrigin: artifact.codeOrigin,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmClass', classId, 'JvmMethod', id, 'DECLARES_METHOD', fact.ordinal,
    ));
    return;
  }
  if (fact.factType === 'field') {
    const id = compactId('jvm-field', stageId, classId, fact.name, fact.descriptor);
    batch.fields.push({
      id, stageId, classId, owner: fact.owner, name: fact.name, descriptor: fact.descriptor,
      declaration: `${fact.access ? `${fact.access} ` : ''}${fact.name}:${fact.descriptor}`,
      access: fact.access || undefined, annotations: [...fact.annotations], codeOrigin: artifact.codeOrigin,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmClass', classId, 'JvmField', id, 'DECLARES_FIELD', fact.ordinal,
    ));
    return;
  }
  const callerId = compactId(
    'jvm-method', stageId, classId, fact.methodName, fact.methodDescriptor,
  );
  discoveredCallTargets.add(fact.targetOwner);
  const callId = compactId(
    'jvm-callsite', stageId, callerId, String(fact.bytecodeOffset),
  );
  batch.callSites.push({
    id: callId, stageId, callerMethodId: callerId,
    bytecodeOffset: fact.bytecodeOffset, opcode: fact.opcode,
    targetOwner: fact.targetOwner, targetName: fact.targetName,
    targetDescriptor: fact.targetDescriptor, status: 'external', codeOrigin: artifact.codeOrigin,
  });
  batch.relations.push(createJvmRelation(
    stageId, 'JvmMethod', callerId, 'JvmCallSite', callId,
    'HAS_BYTECODE_CALLSITE', fact.instructionOrdinal,
  ));
  appendBinaryReference(
    batch, stageId, fact.targetOwner, 'JvmCallSite', callId, 'BYTECODE_CALL_TARGET',
    fact.instructionOrdinal,
  );
}

function appendBinaryReference(
  batch: JvmArtifactBatch,
  stageId: string,
  binaryName: string,
  targetKind: 'JvmClass' | 'JvmCallSite',
  targetId: string,
  kind: 'SUPERCLASS_TARGET' | 'INTERFACE_TARGET' | 'BYTECODE_CALL_TARGET',
  ordinal: number,
): void {
  batch.binaryReferences.push({ binaryName, stageId });
  batch.binaryReferenceRelations.push({
    id: compactId('jvm-binary-reference', stageId, kind, binaryName, targetId, String(ordinal)),
    binaryName, targetKind, targetId, kind, stageId, ordinal,
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
