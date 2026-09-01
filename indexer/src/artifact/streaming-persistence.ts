import fs from 'node:fs';
import path from 'node:path';
import type { DerivedCallNormalizationBatch } from '../derived/call-normalization/model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import { openLspLadybugDatabase, type LadybugModuleLike } from '../lbug/repository.js';
import type { PipelineCheckpointStore } from '../pipeline/checkpoints.js';
import type { JvmArtifactEnrichmentSummary } from './model.js';
import { emptyBazelBuildGraphBatch, type BazelBuildGraphBatch } from '../bazel/model.js';
import {
  emptyRepositoryInventoryBatch,
  type RepositoryInventoryBatch,
} from '../repository/model.js';
import {
  ArtifactBulkSpoolSink,
  bulkCopyArtifactGraph,
  completedArtifactSpools,
} from './bulk-copy.js';
import {
  streamJvmArtifacts,
  type StreamingJvmArtifactEnrichmentInput,
} from './streaming-enrichment.js';
import { bulkCopyBaseGraph } from './base-graph-bulk-copy.js';
import { withMemoryTelemetry } from '../telemetry/memory.js';

interface ArtifactPersistenceManifest {
  formatVersion: 2;
  stagingPath: string;
  basePath: string;
  spoolDirectory: string;
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
  bazelBuildGraphBatch: BazelBuildGraphBatch = emptyBazelBuildGraphBatch(),
  repositoryInventoryBatch: RepositoryInventoryBatch = emptyRepositoryInventoryBatch(),
): Promise<{ output: string; artifactEnrichment: JvmArtifactEnrichmentSummary }> {
  const output = path.resolve(requestedOutputPath);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing LSP database: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = 'jvm-artifact-manifest';
  let manifest = checkpointStore.load<ArtifactPersistenceManifest>(stage, artifactFingerprint);
  const stableStaging = `${output}.partial-${artifactFingerprint.slice(0, 12)}`;
  const stableBase = `${stableStaging}.lsp-base`;
  const stableSpool = `${stableStaging}.artifacts`;
  if (!resume) manifest = undefined;
  const stagingPath = manifest?.stagingPath ?? stableStaging;

  if (manifest?.formatVersion !== 2) manifest = undefined;
  if (!manifest?.initialized || !fs.existsSync(manifest.basePath)) {
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath);
    fs.rmSync(stableBase, { force: true });
    fs.rmSync(stableSpool, { recursive: true, force: true });
    manifest = {
      formatVersion: 2, stagingPath, basePath: stableBase, spoolDirectory: stableSpool,
      initialized: false, completedArtifactIds: [], published: false,
    };
    checkpointStore.save(stage, artifactFingerprint, manifest);
    const initial = openLspLadybugDatabase(stagingPath, ladybug);
    try {
      await initial.repository.initializeSchema();
      await initial.callNormalizationRepository.initializeSchema();
      await initial.bazelBuildGraphRepository.initializeSchema();
      await initial.repositoryInventoryRepository.initializeSchema();
      await initial.artifactRepository.initializeSchema();
      console.log('[stage:base-graph-bulk-copy] loading LSP, derived, Bazel, and repository facts');
      await withMemoryTelemetry('base-graph-insertion', () => bulkCopyBaseGraph(
          initial.repository.connectionForBulkCopy(), `${stableBase}.bulk-work`,
          lspBatch, callNormalizationBatch, bazelBuildGraphBatch, repositoryInventoryBatch,
        ), { graph: 'base' });
    } finally {
      await initial.close();
    }
    cloneOrCopyFile(stagingPath, manifest.basePath);
    manifest.initialized = true;
    checkpointStore.save(stage, artifactFingerprint, manifest);
  }

  // A checkpoint can be written just before or after its sidecar. Trust only
  // validated, atomically completed spools and repair the small manifest in
  // either interruption ordering.
  const completed = new Set(
    [...completedArtifactSpools(manifest.spoolDirectory).values()].map((artifact) => artifact.id),
  );
  manifest.completedArtifactIds = [...completed].sort();
  checkpointStore.save(stage, artifactFingerprint, manifest);
  const sink = new ArtifactBulkSpoolSink(manifest.spoolDirectory, async (
    initialization, finalBatch, spoolFiles, run, resolutions,
  ) => {
    fs.rmSync(stagingPath, { force: true });
    fs.rmSync(`${stagingPath}.wal`, { force: true });
    cloneOrCopyFile(manifest!.basePath, stagingPath);
    let handle = openLspLadybugDatabase(stagingPath, ladybug);
    try {
      await bulkCopyArtifactGraph(
        handle.artifactRepository.connectionForBulkCopy(), initialization, finalBatch,
        spoolFiles, run, `${manifest!.spoolDirectory}.copy-work`, async () => {
          await handle.close();
          handle = openLspLadybugDatabase(stagingPath, ladybug);
          return handle.artifactRepository.connectionForBulkCopy();
        },
        resolutions,
      );
    } finally {
      await handle.close();
    }
  }, async (artifact) => {
    completed.add(artifact.id);
    manifest!.completedArtifactIds = [...completed].sort();
    // Artifact completion is checkpointed after every atomic spool, but a log
    // line per JAR overwhelms useful progress on large classpaths.
    checkpointStore.save(stage, artifactFingerprint, manifest!, false);
  });
  let artifactEnrichment: JvmArtifactEnrichmentSummary;
  try {
    artifactEnrichment = await streamJvmArtifacts(enrichmentInput, sink, completed);
  } catch (error) {
    await sink.close();
    throw error;
  }
  await sink.close();
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing LSP database: ${output}`);
  await withMemoryTelemetry('final-publication', async () => {
    fs.renameSync(stagingPath, output);
    manifest!.published = true;
    checkpointStore.save(stage, artifactFingerprint, manifest!);
    cleanupPublishedSidecars(manifest!);
  }, { output });
  return { output, artifactEnrichment };
}

function cloneOrCopyFile(source: string, destination: string): void {
  try {
    // APFS, Btrfs and XFS can make this a copy-on-write clone. Node falls
    // back to a normal copy when cloning is unsupported.
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
    fs.copyFileSync(source, destination);
  }
}

function cleanupPublishedSidecars(manifest: ArtifactPersistenceManifest): void {
  try {
    fs.rmSync(manifest.basePath, { force: true });
    fs.rmSync(`${manifest.basePath}.wal`, { force: true });
    fs.rmSync(`${manifest.basePath}.bulk-work`, { recursive: true, force: true });
    fs.rmSync(manifest.spoolDirectory, { recursive: true, force: true });
    fs.rmSync(`${manifest.spoolDirectory}.copy-work`, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[stage:final-publication] unable to remove published sidecars: ${String(error)}`);
  }
}
