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
  AsmArtifactAnalysisError,
  AsmWorkerProcessError,
  JVM_PROGRAM_FACT_CONTRACT_VERSION,
  type AsmFact,
  type AsmArtifactRequest,
  type AsmArtifactResult,
  type AsmFactBatch,
  type AsmWorkerInfo,
} from './asm-worker.js';
import {
  createJvmProgramAnalyzer,
  type JvmAnalyzerProvider,
  type JvmProgramAnalyzer,
} from './program-analyzer.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifact,
  type JvmArtifactBatch,
  type JvmArtifactEnrichmentRun,
  type JvmArtifactEnrichmentSummary,
} from './model.js';
import { createHash } from 'node:crypto';
import { startMemoryTelemetry } from '../telemetry/memory.js';

export interface StreamingJvmArtifactEnrichmentInput {
  lspRunId: string;
  artifacts: NormalizedArtifactDescriptor[];
  cacheDirectory: string;
  classpathAttempts?: ArtifactClasspathProviderAttempt[];
  lspBatch: LspObservationBatch;
  maxDisassembledClasses?: number;
  workerConcurrency?: number;
  fetchSources?: boolean;
  analyzer?: JvmAnalyzerProvider;
  projection?: 'legacy' | 'compact';
  externalBodies?: 'none' | 'all';
  configurationHash?: string;
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

/** Stream bounded JVM facts to a durable sink without constructing a repository-wide graph batch. */
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
  const compactBoundaryProjection = input.projection === 'compact'
    && input.externalBodies !== 'all';
  const selectionEnabled = configuredMaximum !== undefined || compactBoundaryProjection;
  const selectionLimit = configuredMaximum ?? Number.MAX_SAFE_INTEGER;
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
  const orderedClasspathHash = createHash('sha256').update(JSON.stringify(
    metadata.artifacts.slice().sort((left, right) => left.classpathOrdinal - right.classpathOrdinal)
      .map((value) => ({ path: jarPaths.get(value.id), hash: value.contentHash })),
  )).digest('hex');

  const run: JvmArtifactEnrichmentRun = {
    id: stageId, lspRunId: input.lspRunId, status: 'running', startedAt,
    provider: input.analyzer ?? 'asm', graphSchemaVersion: input.projection === 'compact' ? 2 : 1,
    projection: input.projection ?? 'legacy',
    classpathProviders: [...new Set(input.artifacts.flatMap((value) => value.providerIds))],
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
  if (selectionEnabled) {
    const unique = new Set<string>();
    for (const seed of seeds) {
      const key = `${seed.artifactId}\0${seed.binaryName}`;
      if (unique.has(key) || unique.size >= selectionLimit) continue;
      unique.add(key);
      selectedByArtifact.set(seed.artifactId, [
        ...(selectedByArtifact.get(seed.artifactId) ?? []), seed.binaryName,
      ]);
    }
  }

  let writeChain = Promise.resolve();
  let completedClasses = 0;
  const discoveredCallTargets = new Set<string>();
  const observedReferenceTypes = new Set<string>();
  const observedMethodReferences = new Map<string, {
    owner: string; name: string; descriptor: string;
  }>();
  let traversalTruncated = false;
  const analysisTelemetry = startMemoryTelemetry('jvm-analysis', {
    provider: input.analyzer ?? 'asm',
    artifacts: metadata.artifacts.length,
    pendingArtifacts: metadata.artifacts.filter((value) => !completedArtifactIds.has(value.id)).length,
    concurrency,
  });
  try {
  const provider = input.analyzer ?? 'asm';
  let worker: JvmProgramAnalyzer = createJvmProgramAnalyzer(provider, concurrency);
  let restartAvailable = true;
  let workerInfo: AsmWorkerInfo;
  try {
    workerInfo = await worker.start();
  } catch (error) {
    if (!(error instanceof AsmWorkerProcessError) || !restartAvailable) throw error;
    restartAvailable = false;
    worker = createJvmProgramAnalyzer(provider, concurrency);
    workerInfo = await worker.start();
  }
  run.providerVersion = workerInfo.providerVersion;
  const processOne = async (
    worker: JvmProgramAnalyzer,
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
      const analysisRequest: AsmArtifactRequest = {
        artifactId: artifact.id,
        jarPath: jarPaths.get(artifact.id)!,
        contentHash: artifact.contentHash,
        classpathOrdinal: artifact.classpathOrdinal,
        runtimeMajor: info.runtimeMajor,
        selectedClasses,
        analyzeAll: !selectionEnabled || (compactBoundaryProjection && isFirstParty(artifact.codeOrigin)),
        emitClassFacts,
        emitSelectedClassFacts: compactBoundaryProjection && !emitClassFacts,
        emitCalls: input.externalBodies === 'all' || isFirstParty(artifact.codeOrigin),
        classpathEntries: (input.externalBodies === 'all' || isFirstParty(artifact.codeOrigin))
          ? metadata.artifacts
            .slice()
            .sort((left, right) => left.classpathOrdinal - right.classpathOrdinal)
            .map((value) => jarPaths.get(value.id)!)
            .filter(Boolean)
          : [jarPaths.get(artifact.id)!],
      };
      const acceptBatch = (workerBatch: AsmFactBatch) => {
        writeChain = writeChain.then(async () => {
          const normalized = normalizeBatch(
            workerBatch, stageId, artifact, seedUris,
            requestedMethodKeys, requestedMethodCandidates,
            discoveredCallTargets, observedReferenceTypes, observedMethodReferences,
            input.projection ?? 'legacy', provider,
          );
          run.classCount += normalized.classes.length;
          run.methodCount += normalized.methods.length;
          run.fieldCount += normalized.fields.length;
          const callCount = normalized.callSites.length + normalized.compactCalls.length;
          run.callSiteCount += callCount;
          artifact.classCount += normalized.classes.length;
          artifact.methodCount += normalized.methods.length;
          artifact.fieldCount += normalized.fields.length;
          artifact.callSiteCount += callCount;
          await sink.write(normalized, artifact.id);
        });
        return writeChain;
      };
      const result = await analyzeArtifactWithCache(
        worker, info, analysisRequest, acceptBatch, input.cacheDirectory,
        createHash('sha256').update(JSON.stringify({
          formatVersion: 2, provider: info.provider, providerVersion: info.providerVersion,
          artifactHash: artifact.contentHash, orderedClasspathHash,
          selectedClasses: [...selectedClasses].sort(), analyzeAll: analysisRequest.analyzeAll,
          emitClassFacts, emitCalls: analysisRequest.emitCalls,
          emitSelectedClassFacts: analysisRequest.emitSelectedClassFacts,
          projection: input.projection ?? 'legacy', externalBodies: input.externalBodies ?? 'none',
          configurationHash: input.configurationHash ?? '',
        })).digest('hex'),
      );
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
        // Rollback must share the same serialization chain as writes and
        // completion renames. Calling it directly lets one failed JAR scan
        // partial spool filenames while another JAR is atomically renaming
        // one of those files, producing a spurious ENOENT during resolution
        // rebuilding.
        writeChain = writeChain
          .catch(() => undefined)
          .then(() => sink.rollbackArtifactAttempt?.(artifact.id));
        await writeChain;
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
      worker = createJvmProgramAnalyzer(provider, concurrency);
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
    !selectionEnabled,
  );
  if (selectionEnabled) {
    const scheduled = new Set<string>();
    for (const [artifactId, names] of selectedByArtifact) {
      for (const name of names) scheduled.add(`${artifactId}\0${name}`);
    }
    while (discoveredCallTargets.size > 0 && scheduled.size < selectionLimit) {
      const targets = [...discoveredCallTargets];
      discoveredCallTargets.clear();
      const resolved = await sink.resolveClassArtifacts(targets);
      const selections = new Map<string, string[]>();
      for (const binaryName of targets) {
        const artifactId = resolved.get(binaryName);
        if (!artifactId) continue;
        const targetArtifact = metadata.artifacts.find((value) => value.id === artifactId);
        if (compactBoundaryProjection && targetArtifact && isFirstParty(targetArtifact.codeOrigin)) continue;
        const key = `${artifactId}\0${binaryName}`;
        if (scheduled.has(key)) continue;
        if (scheduled.size >= selectionLimit) { traversalTruncated = true; break; }
        scheduled.add(key);
        selections.set(artifactId, [...(selections.get(artifactId) ?? []), binaryName]);
      }
      const selectedArtifacts = metadata.artifacts.filter((artifact) => selections.has(artifact.id));
      if (selectedArtifacts.length === 0) break;
      await processAttempt(selectedArtifacts, true, selections, false, false);
    }
    if (discoveredCallTargets.size > 0 && scheduled.size >= selectionLimit) traversalTruncated = true;
    for (const artifact of metadata.artifacts.filter((value) => !completedArtifactIds.has(value.id))) {
      artifact.processingStatus = artifact.errorCount > 0 ? 'partial' : 'complete';
      artifact.completedAt = new Date().toISOString();
      writeChain = writeChain.then(() => sink.completeArtifact(artifact));
    }
    await writeChain;
  }
  await worker.close();
  analysisTelemetry.end();
  } catch (error) {
    analysisTelemetry.end('failed');
    throw error;
  }
  try {
    run.truncated = traversalTruncated;
    run.status = run.errorCount > 0 || run.truncated ? 'partial' : 'complete';
    run.completedAt = new Date().toISOString();
    const bindingBatch = emptyJvmArtifactBatch();
    if ((input.projection ?? 'legacy') === 'compact') {
      const resolvedTypes = await sink.resolveClassArtifacts([...observedReferenceTypes]);
      for (const binaryName of observedReferenceTypes) bindingBatch.typeReferences.push({
        binaryName, stageId, status: resolvedTypes.has(binaryName) ? 'resolved' : 'unresolved',
      });
      for (const [signature, reference] of observedMethodReferences) bindingBatch.methodReferences.push({
        signature, stageId, ...reference,
        status: resolvedTypes.has(reference.owner) ? 'resolved' : 'unresolved',
      });
    }
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
  observedReferenceTypes: Set<string>,
  observedMethodReferences: Map<string, { owner: string; name: string; descriptor: string }>,
  projection: 'legacy' | 'compact',
  provider: JvmAnalyzerProvider,
): JvmArtifactBatch {
  const batch = emptyJvmArtifactBatch();
  for (const fact of workerBatch.facts) normalizeFact(
    fact, stageId, artifact, seedUris, batch, requestedMethodKeys, requestedMethodCandidates,
    discoveredCallTargets, observedReferenceTypes, observedMethodReferences, projection, provider,
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
  observedReferenceTypes: Set<string>,
  observedMethodReferences: Map<string, { owner: string; name: string; descriptor: string }>,
  projection: 'legacy' | 'compact',
  provider: JvmAnalyzerProvider,
): void {
  const classId = compactId('jvm-class', stageId, artifact.id,
    fact.factType === 'class' ? fact.binaryName : fact.owner);
  if (fact.factType === 'class') {
    const uris = seedUris.get(`${artifact.id}\0${fact.binaryName}`) ?? [];
    batch.resolutions.push({
      binaryName: fact.binaryName, stageId, classId, artifactId: artifact.id,
      classpathOrdinal: artifact.classpathOrdinal,
    });
    if (projection === 'compact' && !isFirstParty(artifact.codeOrigin) && !fact.detailed) return;
    batch.classes.push({
      id: classId, stageId, artifactId: artifact.id, binaryName: fact.binaryName,
      packageName: fact.binaryName.includes('.') ? fact.binaryName.slice(0, fact.binaryName.lastIndexOf('.')) : '',
      simpleName: fact.binaryName.slice(fact.binaryName.lastIndexOf('.') + 1),
      kind: fact.kind, access: fact.access || undefined, superName: fact.superName ?? undefined,
      interfaces: [...fact.interfaces],
      sourceEntry: artifact.sourceJarPath
        ? `${fact.binaryName.replaceAll('.', '/').replace(/\$.*$/, '')}.java` : undefined,
      isSeed: uris.length > 0, seedUris: uris, wasDisassembled: fact.detailed,
      annotations: [...fact.annotations], annotationValuesJson: JSON.stringify(fact.annotationValues ?? {}),
      codeOrigin: artifact.codeOrigin,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmArtifact', artifact.id, 'JvmClass', classId,
      'CONTAINS_CLASS', artifact.classCount + batch.classes.length - 1,
    ));
    if (projection === 'compact') {
      if (fact.superName) appendCompactTypeReference(
        batch, stageId, fact.superName, classId, 'SUPERCLASS', 0,
      );
      if (fact.superName) addReferenceTarget(
        fact.superName, discoveredCallTargets, observedReferenceTypes,
      );
      fact.interfaces.forEach((name, ordinal) => appendCompactTypeReference(
        batch, stageId, name, classId, 'INTERFACE', ordinal,
      ));
      for (const name of fact.interfaces) addReferenceTarget(
        name, discoveredCallTargets, observedReferenceTypes,
      );
      fact.annotations.forEach((name, ordinal) => {
        appendCompactTypeReference(batch, stageId, name, classId, 'ANNOTATION', ordinal);
        addReferenceTarget(name, discoveredCallTargets, observedReferenceTypes);
      });
    } else {
      if (fact.superName) appendBinaryReference(
        batch, stageId, fact.superName, 'JvmClass', classId, 'SUPERCLASS_TARGET', 0,
      );
      fact.interfaces.forEach((name, ordinal) => appendBinaryReference(
        batch, stageId, name, 'JvmClass', classId, 'INTERFACE_TARGET', ordinal,
      ));
    }
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
      isExternalPlaceholder: false, annotations: [...fact.annotations],
      annotationValuesJson: JSON.stringify(fact.annotationValues ?? {}), codeOrigin: artifact.codeOrigin,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmClass', classId, 'JvmMethod', id, 'DECLARES_METHOD', fact.ordinal,
    ));
    if (projection === 'compact') {
      for (const [ordinal, name] of descriptorBinaryNames(fact.descriptor).entries()) {
        appendCompactTypeReference(batch, stageId, name, classId, 'SIGNATURE', ordinal,
          `method:${fact.name}${fact.descriptor}`);
        addReferenceTarget(name, discoveredCallTargets, observedReferenceTypes);
      }
      fact.annotations.forEach((name, ordinal) => {
        appendCompactTypeReference(
          batch, stageId, name, classId, 'ANNOTATION', ordinal,
          `method:${fact.name}${fact.descriptor}`,
        );
        addReferenceTarget(name, discoveredCallTargets, observedReferenceTypes);
      });
    }
    return;
  }
  if (fact.factType === 'field') {
    const id = compactId('jvm-field', stageId, classId, fact.name, fact.descriptor);
    batch.fields.push({
      id, stageId, classId, owner: fact.owner, name: fact.name, descriptor: fact.descriptor,
      declaration: `${fact.access ? `${fact.access} ` : ''}${fact.name}:${fact.descriptor}`,
      access: fact.access || undefined, annotations: [...fact.annotations],
      annotationValuesJson: JSON.stringify(fact.annotationValues ?? {}), codeOrigin: artifact.codeOrigin,
    });
    batch.relations.push(createJvmRelation(
      stageId, 'JvmClass', classId, 'JvmField', id, 'DECLARES_FIELD', fact.ordinal,
    ));
    if (projection === 'compact') {
      for (const [ordinal, name] of descriptorBinaryNames(fact.descriptor).entries()) {
        appendCompactTypeReference(batch, stageId, name, classId, 'SIGNATURE', ordinal,
          `field:${fact.name}:${fact.descriptor}`);
        addReferenceTarget(name, discoveredCallTargets, observedReferenceTypes);
      }
      fact.annotations.forEach((name, ordinal) => {
        appendCompactTypeReference(
          batch, stageId, name, classId, 'ANNOTATION', ordinal,
          `field:${fact.name}:${fact.descriptor}`,
        );
        addReferenceTarget(name, discoveredCallTargets, observedReferenceTypes);
      });
    }
    return;
  }
  const callerId = compactId(
    'jvm-method', stageId, classId, fact.methodName, fact.methodDescriptor,
  );
  addReferenceTarget(fact.targetOwner, discoveredCallTargets, observedReferenceTypes);
  if (projection === 'compact') {
    const targetSignature = `${fact.targetOwner}#${fact.targetName}${fact.targetDescriptor}`;
    observedMethodReferences.set(targetSignature, {
      owner: fact.targetOwner, name: fact.targetName, descriptor: fact.targetDescriptor,
    });
    batch.methodReferences.push({
      signature: targetSignature, stageId, owner: fact.targetOwner,
      name: fact.targetName, descriptor: fact.targetDescriptor, status: 'external',
    });
    batch.compactCalls.push({
      id: compactId('jvm-compact-call', stageId, callerId, String(fact.bytecodeOffset), targetSignature),
      stageId, callerMethodId: callerId, targetSignature,
      bytecodeOffset: fact.bytecodeOffset, opcode: fact.opcode,
      dispatchKind: dispatchKind(fact.opcode), confidence: directCallConfidence(fact.opcode),
      evidence: provider === 'sootup'
        ? 'SootUp transient Jimple invocation'
        : 'ASM bytecode invocation',
      ordinal: fact.instructionOrdinal,
    });
    return;
  }
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

function dispatchKind(opcode: string): 'static' | 'special' | 'virtual' | 'interface' | 'dynamic' | 'unknown' {
  if (opcode === 'invokestatic') return 'static';
  if (opcode === 'invokespecial') return 'special';
  if (opcode === 'invokevirtual') return 'virtual';
  if (opcode === 'invokeinterface') return 'interface';
  if (opcode === 'invokedynamic') return 'dynamic';
  return 'unknown';
}

function directCallConfidence(opcode: string): number {
  return opcode === 'invokestatic' || opcode === 'invokespecial' ? 1 : 0.9;
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

function appendCompactTypeReference(
  batch: JvmArtifactBatch,
  stageId: string,
  binaryName: string,
  sourceClassId: string,
  kind: 'SUPERCLASS' | 'INTERFACE' | 'SIGNATURE' | 'ANNOTATION',
  ordinal: number,
  identity = '',
): void {
  batch.typeReferences.push({ binaryName, stageId, status: 'external' });
  batch.compactTypeReferences.push({
    id: compactId('jvm-compact-type-reference', stageId, sourceClassId, binaryName, kind, identity, String(ordinal)),
    stageId, sourceClassId, targetBinaryName: binaryName, kind, confidence: 1, ordinal,
  });
}

function descriptorBinaryNames(descriptor: string): string[] {
  return [...descriptor.matchAll(/L([^;]+);/g)].map((match) => match[1]!.replaceAll('/', '.'));
}

function addReferenceTarget(
  binaryName: string,
  pendingTargets: Set<string>,
  observedTypes: Set<string>,
): void {
  pendingTargets.add(binaryName);
  observedTypes.add(binaryName);
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isFirstParty(origin: JvmArtifact['codeOrigin']): boolean {
  return origin === 'first_party_artifact' || origin === 'generated_first_party' || origin === 'repository';
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function analyzeArtifactWithCache(
  worker: JvmProgramAnalyzer,
  info: AsmWorkerInfo,
  request: AsmArtifactRequest,
  onBatch: (batch: AsmFactBatch) => void | Promise<void>,
  cacheDirectory: string,
  cacheKey: string,
): Promise<AsmArtifactResult> {
  const directory = path.join(cacheDirectory, 'program-facts', info.provider);
  const cachePath = path.join(directory, `${cacheKey}.ndjson`);
  if (isCompleteFactCache(cachePath, cacheKey) && await validateFactCache(cachePath, cacheKey)) {
    const lines = (await import('node:readline')).createInterface({
      input: fs.createReadStream(cachePath, { encoding: 'utf8' }), crlfDelay: Infinity,
    });
    let result: AsmArtifactResult | undefined;
    for await (const line of lines) {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === 'batch') {
        const batch = value.batch as AsmFactBatch;
        await onBatch({ ...batch, artifactId: request.artifactId });
      } else if (value.type === 'complete') {
        result = { ...(value.result as unknown as AsmArtifactResult), artifactId: request.artifactId };
      }
    }
    if (result) return result;
  }
  fs.rmSync(cachePath, { force: true });

  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ type: 'header', formatVersion: 2, cacheKey })}\n`);
  try {
    const result = await worker.analyzeArtifact(request, async (batch) => {
      fs.appendFileSync(temporary, `${JSON.stringify({ type: 'batch', batch })}\n`);
      await onBatch(batch);
    });
    fs.appendFileSync(temporary, `${JSON.stringify({ type: 'complete', cacheKey, result })}\n`);
    fs.renameSync(temporary, cachePath);
    return result;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function isCompleteFactCache(filePath: string, cacheKey: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size === 0) return false;
  const length = Math.min(size, 64 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    const last = buffer.toString('utf8').trim().split(/\r?\n/).at(-1);
    if (!last) return false;
    const value = JSON.parse(last) as Record<string, unknown>;
    return value.type === 'complete' && value.cacheKey === cacheKey;
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function validateFactCache(filePath: string, cacheKey: string): Promise<boolean> {
  try {
    const lines = (await import('node:readline')).createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity,
    });
    let header = false;
    let complete = false;
    const sequences = new Map<string, number>();
    for await (const line of lines) {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!header) {
        header = value.type === 'header' && value.formatVersion === 2 && value.cacheKey === cacheKey;
        if (!header) return false;
        continue;
      }
      if (value.type === 'batch') {
        const batch = value.batch as AsmFactBatch;
        const expected = sequences.get(batch.artifactId) ?? 0;
        if (batch.contractVersion !== JVM_PROGRAM_FACT_CONTRACT_VERSION
          || batch.sequence !== expected || !Array.isArray(batch.facts) || batch.facts.length > 500) return false;
        sequences.set(batch.artifactId, expected + 1);
      } else if (value.type === 'complete') {
        if (value.cacheKey !== cacheKey) return false;
        complete = true;
      } else return false;
    }
    return header && complete;
  } catch {
    return false;
  }
}
