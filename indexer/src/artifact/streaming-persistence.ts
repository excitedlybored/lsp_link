import fs from 'node:fs';
import path from 'node:path';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import { openLspLadybugDatabase, type LadybugModuleLike, type LspDatabaseHandle } from '../lbug/repository.js';
import type { PipelineCheckpointStore } from '../pipeline/checkpoints.js';
import type { JvmArtifact, JvmArtifactBatch, JvmArtifactEnrichmentRun, JvmArtifactEnrichmentSummary } from './model.js';
import {
  streamJvmArtifacts,
  type JvmArtifactStreamingSink,
  type StreamingJvmArtifactEnrichmentInput,
} from './streaming-enrichment.js';

interface ArtifactPersistenceManifest {
  stagingPath: string;
  initialized: boolean;
  completedArtifactIds: string[];
  published: boolean;
}

export async function persistStreamingKnowledgeGraph(
  requestedOutputPath: string,
  artifactFingerprint: string,
  checkpointStore: PipelineCheckpointStore,
  lspBatch: LspObservationBatch,
  callNormalizationBatch: DerivedCallNormalizationBatch,
  enrichmentInput: StreamingJvmArtifactEnrichmentInput,
  ladybug: LadybugModuleLike,
  resume: boolean,
): Promise<{ output: string; artifactEnrichment: JvmArtifactEnrichmentSummary }> {
  const output = path.resolve(requestedOutputPath);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing LSP database: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = 'jvm-artifact-manifest';
  let manifest = checkpointStore.load<ArtifactPersistenceManifest>(stage, artifactFingerprint);
  const stableStaging = `${output}.partial-${artifactFingerprint.slice(0, 12)}`;
  if (!resume) manifest = undefined;
  const stagingPath = manifest?.stagingPath ?? stableStaging;

  if (!manifest?.initialized || !fs.existsSync(stagingPath)) {
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath);
    manifest = { stagingPath, initialized: false, completedArtifactIds: [], published: false };
    checkpointStore.save(stage, artifactFingerprint, manifest);
    const initial = openLspLadybugDatabase(stagingPath, ladybug);
    try {
      await initial.repository.initializeSchema();
      await initial.repository.writeBatch(lspBatch);
      await initial.callNormalizationRepository.initializeSchema();
      await initial.callNormalizationRepository.writeBatch(callNormalizationBatch);
      await initial.artifactRepository.initializeSchema();
    } finally {
      await initial.close();
    }
    manifest.initialized = true;
    checkpointStore.save(stage, artifactFingerprint, manifest);
  }

  const completed = new Set(manifest.completedArtifactIds);
  const sink = new LadybugArtifactStreamingSink(
    stagingPath,
    ladybug,
    async (artifact) => {
      if (artifact.processingStatus !== 'complete' && artifact.processingStatus !== 'partial') return;
      completed.add(artifact.id);
      manifest!.completedArtifactIds = [...completed].sort();
      checkpointStore.save(stage, artifactFingerprint, manifest!);
    },
  );
  let artifactEnrichment: JvmArtifactEnrichmentSummary;
  try {
    artifactEnrichment = await streamJvmArtifacts(enrichmentInput, sink, completed);
  } catch (error) {
    await sink.close();
    throw error;
  }
  await sink.close();
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing LSP database: ${output}`);
  fs.renameSync(stagingPath, output);
  manifest.published = true;
  checkpointStore.save(stage, artifactFingerprint, manifest);
  return { output, artifactEnrichment };
}

class LadybugArtifactStreamingSink implements JvmArtifactStreamingSink {
  private handle: LspDatabaseHandle;
  private batchesSinceRotation = 0;
  private readonly rotationBatches: number;

  constructor(
    private readonly stagingPath: string,
    private readonly ladybug: LadybugModuleLike,
    private readonly onCompletedArtifact: (artifact: JvmArtifact) => Promise<void>,
  ) {
    this.handle = openLspLadybugDatabase(stagingPath, ladybug);
    const configured = Number(process.env.GITNEXUS_LBUG_ROTATE_BATCHES ?? 25);
    if (!Number.isInteger(configured) || configured < 1) {
      throw new Error(`GITNEXUS_LBUG_ROTATE_BATCHES must be a positive integer, got ${configured}`);
    }
    this.rotationBatches = configured;
  }

  async initialize(run: JvmArtifactEnrichmentRun, metadata: JvmArtifactBatch): Promise<void> {
    await this.handle.artifactRepository.mergeBatch(metadata);
  }

  async write(batch: JvmArtifactBatch): Promise<void> {
    await this.handle.artifactRepository.mergeBatch(batch);
    this.batchesSinceRotation++;
    if (this.batchesSinceRotation >= this.rotationBatches) await this.rotate();
  }

  async completeArtifact(artifact: JvmArtifact): Promise<void> {
    const batch = emptyBatch();
    batch.artifacts.push(artifact);
    await this.handle.artifactRepository.mergeBatch(batch);
    await this.onCompletedArtifact(artifact);
  }

  async resolveClassArtifacts(binaryNames: string[]): Promise<Map<string, string>> {
    return this.handle.artifactRepository.resolveClassArtifacts(binaryNames);
  }

  async finalize(run: JvmArtifactEnrichmentRun, _lspBatch: LspObservationBatch): Promise<void> {
    await this.handle.artifactRepository.finalizeAsmRelations(run.id);
    await this.handle.artifactRepository.finalizeAsmRun(run);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async rotate(): Promise<void> {
    await this.handle.close();
    this.handle = openLspLadybugDatabase(this.stagingPath, this.ladybug);
    this.batchesSinceRotation = 0;
  }
}

function emptyBatch(): JvmArtifactBatch {
  return {
    runs: [], artifacts: [], resolutions: [], binaryReferences: [], binaryReferenceRelations: [],
    classes: [], methods: [], fields: [],
    callSites: [], relations: [], bindings: [],
  };
}
