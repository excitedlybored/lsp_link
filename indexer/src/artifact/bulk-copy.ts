import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { LbugConnectionLike, LbugQueryResultLike } from '../lbug/repository.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifact,
  type JvmArtifactBatch,
  type JvmArtifactEnrichmentRun,
  type JvmClassResolution,
} from './model.js';
import type { JvmArtifactStreamingSink } from './streaming-enrichment.js';
import { JvmArtifactRepository } from './repository.js';
import {
  BulkCsvFiles,
  closeQueryResults,
  copyNodeCsvFragments,
  copyRelationCsvFragments,
  updateArrayProperties,
} from './bulk-copy-support.js';
import { withMemoryTelemetry } from '../telemetry/memory.js';

const COPY_ROWS_PER_FILE = positiveInteger(
  process.env.GITNEXUS_LBUG_COPY_ROWS, 10_000, 'GITNEXUS_LBUG_COPY_ROWS',
);
const COPY_FRAGMENTS_PER_ROTATION = positiveInteger(
  process.env.GITNEXUS_LBUG_ROTATE_BATCHES, 20, 'GITNEXUS_LBUG_ROTATE_BATCHES',
);

export class ArtifactBulkSpoolSink implements JvmArtifactStreamingSink {
  private readonly resolutions = new Map<string, JvmClassResolution>();
  private readonly attemptOffsets = new Map<string, number>();
  private initialization = emptyJvmArtifactBatch();
  private finalBatch = emptyJvmArtifactBatch();

  constructor(
    readonly spoolDirectory: string,
    private readonly publish: (
      initialization: JvmArtifactBatch,
      finalBatch: JvmArtifactBatch,
      spoolFiles: string[],
      run: JvmArtifactEnrichmentRun,
      resolutions: ReadonlyMap<string, JvmClassResolution>,
    ) => Promise<void>,
    private readonly onCompletedArtifact: (artifact: JvmArtifact) => Promise<void> = async () => undefined,
  ) {
    fs.mkdirSync(spoolDirectory, { recursive: true });
  }

  async initialize(_run: JvmArtifactEnrichmentRun, batch: JvmArtifactBatch): Promise<void> {
    this.initialization = batch;
    for (const artifact of batch.artifacts) {
      fs.rmSync(this.partialPath(artifact.id), { force: true });
      fs.rmSync(this.completePath(artifact.id), { force: true });
      fs.rmSync(`${this.completePath(artifact.id)}.artifact.json`, { force: true });
    }
    for (const [file, artifact] of completedArtifactSpools(this.spoolDirectory)) {
      _run.classCount += artifact.classCount;
      _run.methodCount += artifact.methodCount;
      _run.fieldCount += artifact.fieldCount;
      _run.callSiteCount += artifact.callSiteCount;
      _run.errorCount += artifact.errorCount;
      await this.readResolutions(file);
    }
  }

  async beginArtifactAttempt(artifactId: string): Promise<void> {
    const file = this.partialPath(artifactId);
    this.attemptOffsets.set(artifactId, fs.existsSync(file) ? fs.statSync(file).size : 0);
  }

  async rollbackArtifactAttempt(artifactId: string): Promise<void> {
    const file = this.partialPath(artifactId);
    const offset = this.attemptOffsets.get(artifactId) ?? 0;
    if (fs.existsSync(file)) {
      if (offset === 0) fs.rmSync(file, { force: true });
      else fs.truncateSync(file, offset);
    }
    this.attemptOffsets.delete(artifactId);
    await this.rebuildResolutions();
  }

  async write(batch: JvmArtifactBatch, artifactId?: string): Promise<void> {
    for (const resolution of batch.resolutions) this.selectResolution(resolution);
    if (!artifactId) {
      mergeBatch(this.finalBatch, batch);
      return;
    }
    fs.appendFileSync(this.partialPath(artifactId), `${JSON.stringify(batch)}\n`, 'utf8');
  }

  async completeArtifact(artifact: JvmArtifact): Promise<void> {
    if (artifact.processingStatus !== 'complete' && artifact.processingStatus !== 'partial') return;
    const partial = this.partialPath(artifact.id);
    const complete = this.completePath(artifact.id);
    if (fs.existsSync(partial)) {
      fs.rmSync(complete, { force: true });
      fs.renameSync(partial, complete);
    }
    else if (!fs.existsSync(complete)) fs.writeFileSync(complete, '', 'utf8');
    atomicJson(`${complete}.artifact.json`, artifact);
    this.attemptOffsets.delete(artifact.id);
    await this.onCompletedArtifact(artifact);
  }

  async resolveClassArtifacts(binaryNames: string[]): Promise<Map<string, string>> {
    return new Map(binaryNames.flatMap((name) => {
      const artifactId = this.resolutions.get(name)?.artifactId;
      return artifactId ? [[name, artifactId] as const] : [];
    }));
  }

  async finalize(run: JvmArtifactEnrichmentRun): Promise<void> {
    await this.publish(
      this.initialization, this.finalBatch, this.completedFiles(), run, this.resolutions,
    );
  }

  async close(): Promise<void> {}

  private async readResolutions(file: string): Promise<void> {
    for await (const batch of readBatches(file)) {
      for (const resolution of batch.resolutions) this.selectResolution(resolution);
    }
  }

  private async rebuildResolutions(): Promise<void> {
    this.resolutions.clear();
    const files = [
      ...this.completedFiles(),
      ...fs.readdirSync(this.spoolDirectory)
        .filter((name) => name.endsWith('.partial.ndjson')).sort()
        .map((name) => path.join(this.spoolDirectory, name)),
    ];
    for (const file of files) await this.readResolutions(file);
  }

  private selectResolution(value: JvmClassResolution): void {
    const current = this.resolutions.get(value.binaryName);
    if (!current || value.classpathOrdinal < current.classpathOrdinal) {
      this.resolutions.set(value.binaryName, value);
    }
  }

  private completedFiles(): string[] {
    return [...completedArtifactSpools(this.spoolDirectory).keys()];
  }

  private partialPath(id: string): string { return path.join(this.spoolDirectory, `${safeName(id)}.partial.ndjson`); }
  private completePath(id: string): string { return path.join(this.spoolDirectory, `${safeName(id)}.complete.ndjson`); }
}

/** Completed sidecars are the durable resume authority, not the checkpoint manifest alone. */
export function completedArtifactSpools(spoolDirectory: string): Map<string, JvmArtifact> {
  const completed = new Map<string, JvmArtifact>();
  if (!fs.existsSync(spoolDirectory)) return completed;
  for (const name of fs.readdirSync(spoolDirectory).filter((value) =>
    value.endsWith('.complete.ndjson')).sort()) {
    const file = path.join(spoolDirectory, name);
    const metadata = `${file}.artifact.json`;
    if (!fs.existsSync(metadata)) continue;
    try {
      const artifact = JSON.parse(fs.readFileSync(metadata, 'utf8')) as JvmArtifact;
      if (
        (artifact.processingStatus === 'complete' || artifact.processingStatus === 'partial')
        && path.basename(file) === `${safeName(artifact.id)}.complete.ndjson`
      ) completed.set(file, artifact);
    } catch { /* an interrupted sidecar write is incomplete and must be replayed */ }
  }
  return completed;
}

export async function bulkCopyArtifactGraph(
  connection: LbugConnectionLike,
  initialization: JvmArtifactBatch,
  finalBatch: JvmArtifactBatch,
  spoolFiles: string[],
  run: JvmArtifactEnrichmentRun,
  workDirectory: string,
  rotateConnection?: () => Promise<LbugConnectionLike>,
  selectedResolutions?: ReadonlyMap<string, JvmClassResolution>,
): Promise<void> {
  let activeConnection = connection;
  const trace = (message: string) => { if (process.env.GITNEXUS_BULK_COPY_TRACE === '1') console.error(`[bulk-copy] ${message}`); };
  let copiedFragments = 0;
  const checkpointCopiedFragments = async () => {
    copiedFragments++;
    if (rotateConnection && copiedFragments % COPY_FRAGMENTS_PER_ROTATION === 0) {
      trace(`rotate after ${copiedFragments} COPY fragments`);
      activeConnection = await rotateConnection();
    }
  };
  fs.rmSync(workDirectory, { recursive: true, force: true });
  fs.mkdirSync(workDirectory, { recursive: true });
  const csv = new BulkCsvFiles(workDirectory, COPY_ROWS_PER_FILE);
  const computedResolutions = selectedResolutions
    ? undefined
    : new Map<string, JvmClassResolution>();
  const resolutions = selectedResolutions ?? computedResolutions!;
  const references = new Map<string, string>();
  try {
    await withMemoryTelemetry('csv-generation', async () => {
      for (const file of spoolFiles) {
        for await (const batch of readBatches(file)) {
          writeFacts(csv, batch);
          if (!selectedResolutions) for (const value of batch.resolutions) {
            const current = resolutions.get(value.binaryName);
            if (!current || value.classpathOrdinal < current.classpathOrdinal) {
              computedResolutions!.set(value.binaryName, value);
            }
          }
          for (const value of batch.binaryReferences) references.set(value.binaryName, value.stageId);
        }
      }
      for (const value of resolutions.values()) csv.row('JvmClassResolution', [
        value.binaryName, value.stageId, value.classId, value.artifactId, value.classpathOrdinal,
      ]);
      for (const [binaryName, stageId] of references) csv.row('JvmBinaryReference', [binaryName, stageId]);
      for (const value of resolutions.values()) {
        if (!references.has(value.binaryName)) continue;
        csv.row(RESOLUTION_LINK.key, [
          value.classId,
          value.binaryName,
          `resolved-reference:${value.binaryName}`,
          value.stageId,
        ]);
      }
      csv.close();
    }, { graph: 'jvm', spoolFiles: spoolFiles.length });
  } finally {
    csv.close();
  }

  await withMemoryTelemetry('node-copying', async () => {
    const progress = copyProgress(
      'node-copying',
      NODE_TABLES.reduce((sum, table) => sum + csv.fragments(table.key, table.columns).length, 0),
    );
    for (const table of NODE_TABLES) {
      trace(`node ${table.name}`);
      await copyNodeCsvFragments(
        () => activeConnection, csv, table.key, table.name, table.columns, async () => {
          await checkpointCopiedFragments();
          progress();
        },
      );
    }
  }, { graph: 'jvm' });

  let repository = new JvmArtifactRepository(activeConnection);
  const metadata = emptyJvmArtifactBatch();
  metadata.runs.push(run);
  for (const file of spoolFiles) {
    const artifactFile = `${file}.artifact.json`;
    if (fs.existsSync(artifactFile)) metadata.artifacts.push(JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as JvmArtifact);
  }
  // Relationship COPY resolves endpoint primary keys, so the small run and
  // artifact metadata nodes must exist before containment edges are loaded.
  await repository.mergeBatch(metadata);
  await withMemoryTelemetry('relationship-copying', async () => {
    const progress = copyProgress(
      'relationship-copying',
      RELATION_TABLES.reduce((sum, relation) =>
        sum + csv.fragments(relation.key, relation.columns).length, 0)
        + csv.fragments(RESOLUTION_LINK.key, RESOLUTION_LINK.columns).length,
    );
    for (const relation of RELATION_TABLES) {
      trace(`relationship ${relation.table} ${relation.from}->${relation.to}`);
      await copyRelationCsvFragments(
        () => activeConnection, csv, relation.key, relation.table, relation.columns, relation.from, relation.to,
        async () => {
          await checkpointCopiedFragments();
          progress();
        },
      );
    }
    await copyRelationCsvFragments(
      () => activeConnection,
      csv,
      RESOLUTION_LINK.key,
      RESOLUTION_LINK.table,
      RESOLUTION_LINK.columns,
      RESOLUTION_LINK.from,
      RESOLUTION_LINK.to,
      async () => {
        await checkpointCopiedFragments();
        progress();
      },
    );
  }, { graph: 'jvm' });

  // Array properties cannot safely encode arbitrary comma-containing values in
  // Ladybug CSV lists. Apply them after scalar COPY in bounded batches.
  for (const file of spoolFiles) for await (const batch of readBatches(file)) {
    trace(`array properties ${path.basename(file)}`);
    await updateArrayProperties(activeConnection, 'JvmClass', batch.classes.filter((value) =>
      value.interfaces.length > 0 || value.seedUris.length > 0 || value.annotations.length > 0,
    ).map((value) => ({
      id: value.id, interfaces: value.interfaces, seedUris: value.seedUris, annotations: value.annotations,
    })), ['interfaces', 'seedUris', 'annotations']);
    await updateArrayProperties(activeConnection, 'JvmMethod', batch.methods.filter((value) => value.annotations.length > 0).map((value) => ({
      id: value.id, annotations: value.annotations,
    })), ['annotations']);
    await updateArrayProperties(activeConnection, 'JvmField', batch.fields.filter((value) => value.annotations.length > 0).map((value) => ({
      id: value.id, annotations: value.annotations,
    })), ['annotations']);
  }

  const links = emptyJvmArtifactBatch();
  links.relations.push(...initialization.relations);
  links.bindings.push(...finalBatch.bindings);
  repository = new JvmArtifactRepository(activeConnection);
  await repository.mergeBatch(links);
  await withMemoryTelemetry('resolution-finalization', async () => {
    trace('final relations');
    await repository.finalizeAsmRelations(run.id);
    trace('final counts');
    await repository.finalizeAsmRun(run);
  }, { graph: 'jvm' });
}

const NODE_TABLES = [
  { key: 'JvmClass', name: 'JvmClass', columns: ['id','stageId','artifactId','binaryName','packageName','simpleName','kind','access','superName','sourceEntry','isSeed','wasDisassembled','codeOrigin'] },
  { key: 'JvmMethod', name: 'JvmMethod', columns: ['id','stageId','classId','owner','name','descriptor','declaration','access','hasCode','isExternalPlaceholder','codeOrigin'] },
  { key: 'JvmField', name: 'JvmField', columns: ['id','stageId','classId','owner','name','descriptor','declaration','access','codeOrigin'] },
  { key: 'JvmCallSite', name: 'JvmCallSite', columns: ['id','stageId','callerMethodId','bytecodeOffset','opcode','targetOwner','targetName','targetDescriptor','status','codeOrigin'] },
  { key: 'JvmClassResolution', name: 'JvmClassResolution', columns: ['binaryName','stageId','classId','artifactId','classpathOrdinal'] },
  { key: 'JvmBinaryReference', name: 'JvmBinaryReference', columns: ['binaryName','stageId'] },
] as const;

const RELATION_TABLES = [
  ...([['JvmArtifact','JvmClass'],['JvmClass','JvmMethod'],['JvmClass','JvmField'],['JvmClass','JvmClass'],['JvmMethod','JvmCallSite'],['JvmCallSite','JvmMethod']] as const)
    .map(([from, to]) => ({ key: `JvmRelation-${from}-${to}`, table: 'JvmRelation', from, to, columns: ['from','to','id','kind','stageId','status','ordinal'] })),
  ...([['JvmBinaryReference','JvmClass'],['JvmBinaryReference','JvmCallSite']] as const)
    .map(([from, to]) => ({ key: `JvmBinaryReferenceRelation-${to}`, table: 'JvmBinaryReferenceRelation', from, to, columns: ['from','to','id','kind','stageId','ordinal'] })),
] as const;

const RESOLUTION_LINK = {
  key: 'JvmResolvedReference-JvmClass-JvmBinaryReference',
  table: 'JvmResolvedReference',
  from: 'JvmClass',
  to: 'JvmBinaryReference',
  columns: ['from', 'to', 'id', 'stageId'],
} as const;

function writeFacts(csv: BulkCsvFiles, batch: JvmArtifactBatch): void {
  for (const v of batch.classes) csv.object('JvmClass', v as unknown as Record<string, unknown>, NODE_TABLES[0].columns);
  for (const v of batch.methods) csv.object('JvmMethod', v as unknown as Record<string, unknown>, NODE_TABLES[1].columns);
  for (const v of batch.fields) csv.object('JvmField', v as unknown as Record<string, unknown>, NODE_TABLES[2].columns);
  for (const v of batch.callSites) csv.object('JvmCallSite', v as unknown as Record<string, unknown>, NODE_TABLES[3].columns);
  for (const v of batch.relations) {
    const key = `JvmRelation-${v.sourceKind}-${v.targetKind}`;
    const spec = RELATION_TABLES.find((value) => value.key === key)!;
    csv.object(key, {
      from: v.sourceId, to: v.targetId, id: v.id, kind: v.kind,
      stageId: v.stageId, status: v.status, ordinal: v.ordinal ?? null,
    }, spec.columns);
  }
  for (const v of batch.binaryReferenceRelations) {
    const key = `JvmBinaryReferenceRelation-${v.targetKind}`;
    const spec = RELATION_TABLES.find((value) => value.key === key)!;
    csv.object(key, {
      from: v.binaryName, to: v.targetId, id: v.id, kind: v.kind,
      stageId: v.stageId, ordinal: v.ordinal,
    }, spec.columns);
  }
}

async function* readBatches(file: string): AsyncIterable<JvmArtifactBatch> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as JvmArtifactBatch;
}

function safeName(value: string): string { return Buffer.from(value).toString('base64url'); }
function atomicJson(file: string, value: unknown): void { const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
function mergeBatch(target: JvmArtifactBatch, source: JvmArtifactBatch): void { for (const key of Object.keys(target) as Array<keyof JvmArtifactBatch>) (target[key] as unknown[]).push(...source[key] as unknown[]); }
async function close(result: LbugQueryResultLike | LbugQueryResultLike[]): Promise<void> { await closeQueryResults(result); }
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}

function copyProgress(stage: string, total: number): () => void {
  let completed = 0;
  let lastLogAt = Date.now();
  return () => {
    completed++;
    const now = Date.now();
    if (completed !== total && now - lastLogAt < 15_000) return;
    const percent = total === 0 ? 100 : Math.floor(completed / total * 100);
    console.log(`[stage:${stage}] ${completed}/${total} COPY fragments (${percent}%)`);
    lastLogAt = now;
  };
}
