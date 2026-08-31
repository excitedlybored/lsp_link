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

const NULL = '__GITNEXUS_NULL_7d35b31b__';
const COPY_ROWS_PER_FILE = 500;
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
    await this.publish(this.initialization, this.finalBatch, this.completedFiles(), run);
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
  const csv = new CsvFiles(workDirectory);
  const resolutions = new Map<string, JvmClassResolution>();
  const references = new Map<string, string>();
  try {
    for (const file of spoolFiles) {
      for await (const batch of readBatches(file)) {
        writeFacts(csv, batch);
        for (const value of batch.resolutions) {
          const current = resolutions.get(value.binaryName);
          if (!current || value.classpathOrdinal < current.classpathOrdinal) resolutions.set(value.binaryName, value);
        }
        for (const value of batch.binaryReferences) references.set(value.binaryName, value.stageId);
      }
    }
    for (const value of resolutions.values()) csv.row('JvmClassResolution', [
      value.binaryName, value.stageId, value.classId, value.artifactId, value.classpathOrdinal,
    ]);
    for (const [binaryName, stageId] of references) csv.row('JvmBinaryReference', [binaryName, stageId]);
  } finally {
    csv.close();
  }

  for (const table of NODE_TABLES) for (const file of csv.paths(table.key)) {
    trace(`node ${table.name} ${path.basename(file)}`);
    await copyIfPresent(activeConnection, table.name, file, table.columns);
    await checkpointCopiedFragments();
  }

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
  for (const relation of RELATION_TABLES) for (const file of csv.paths(relation.key)) {
    trace(`relationship ${relation.table} ${relation.from}->${relation.to} ${path.basename(file)}`);
    await copyRelationIfPresent(
      activeConnection, relation.table, file, relation.columns, relation.from, relation.to,
    );
    await checkpointCopiedFragments();
  }

  // Array properties cannot safely encode arbitrary comma-containing values in
  // Ladybug CSV lists. Apply them after scalar COPY in bounded batches.
  for (const file of spoolFiles) for await (const batch of readBatches(file)) {
    trace(`array properties ${path.basename(file)}`);
    await updateArrays(activeConnection, 'JvmClass', batch.classes.filter((value) =>
      value.interfaces.length > 0 || value.seedUris.length > 0 || value.annotations.length > 0,
    ).map((value) => ({
      id: value.id, interfaces: value.interfaces, seedUris: value.seedUris, annotations: value.annotations,
    })), ['interfaces', 'seedUris', 'annotations']);
    await updateArrays(activeConnection, 'JvmMethod', batch.methods.filter((value) => value.annotations.length > 0).map((value) => ({
      id: value.id, annotations: value.annotations,
    })), ['annotations']);
    await updateArrays(activeConnection, 'JvmField', batch.fields.filter((value) => value.annotations.length > 0).map((value) => ({
      id: value.id, annotations: value.annotations,
    })), ['annotations']);
  }

  const links = emptyJvmArtifactBatch();
  links.relations.push(...initialization.relations);
  links.bindings.push(...finalBatch.bindings);
  repository = new JvmArtifactRepository(activeConnection);
  await repository.mergeBatch(links);
  trace('resolution links');
  await createResolutionLinks(activeConnection, resolutions.values());
  trace('final relations');
  await repository.finalizeAsmRelations(run.id);
  trace('final counts');
  await repository.finalizeAsmRun(run);
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

function writeFacts(csv: CsvFiles, batch: JvmArtifactBatch): void {
  for (const v of batch.classes) csv.row('JvmClass', [v.id,v.stageId,v.artifactId,v.binaryName,v.packageName,v.simpleName,v.kind,v.access,v.superName,v.sourceEntry,v.isSeed,v.wasDisassembled,v.codeOrigin]);
  for (const v of batch.methods) csv.row('JvmMethod', [v.id,v.stageId,v.classId,v.owner,v.name,v.descriptor,v.declaration,v.access,v.hasCode,v.isExternalPlaceholder,v.codeOrigin]);
  for (const v of batch.fields) csv.row('JvmField', [v.id,v.stageId,v.classId,v.owner,v.name,v.descriptor,v.declaration,v.access,v.codeOrigin]);
  for (const v of batch.callSites) csv.row('JvmCallSite', [v.id,v.stageId,v.callerMethodId,v.bytecodeOffset,v.opcode,v.targetOwner,v.targetName,v.targetDescriptor,v.status,v.codeOrigin]);
  for (const v of batch.relations) csv.row(`JvmRelation-${v.sourceKind}-${v.targetKind}`, [v.sourceId,v.targetId,v.id,v.kind,v.stageId,v.status,v.ordinal]);
  for (const v of batch.binaryReferenceRelations) csv.row(`JvmBinaryReferenceRelation-${v.targetKind}`, [v.binaryName,v.targetId,v.id,v.kind,v.stageId,v.ordinal]);
}

class CsvFiles {
  private readonly descriptors = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  constructor(private readonly directory: string) {}
  paths(key: string): string[] {
    const count = this.counts.get(key) ?? 0;
    return Array.from({ length: Math.ceil(count / COPY_ROWS_PER_FILE) }, (_, index) => this.path(key, index));
  }
  row(key: string, values: unknown[]): void {
    const count = this.counts.get(key) ?? 0;
    const index = Math.floor(count / COPY_ROWS_PER_FILE);
    const descriptorKey = `${key}\0${index}`;
    let descriptor = this.descriptors.get(descriptorKey);
    if (descriptor === undefined) {
      descriptor = fs.openSync(this.path(key, index), 'a');
      this.descriptors.set(descriptorKey, descriptor);
    }
    fs.writeSync(descriptor, `${values.map(csvValue).join(',')}\n`);
    this.counts.set(key, count + 1);
  }
  close(): void { for (const descriptor of this.descriptors.values()) fs.closeSync(descriptor); this.descriptors.clear(); }
  private path(key: string, index: number): string { return path.join(this.directory, `${key}.${index}.csv`); }
}

async function copyIfPresent(connection: LbugConnectionLike, table: string, file: string, columns: readonly string[]): Promise<void> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
  await query(connection, `COPY ${table}(${columns.join(',')}) FROM ${literal(file)} (AUTO_DETECT=false, PARALLEL=false, NULL_STRINGS=[${literal(NULL)}])`);
}

async function copyRelationIfPresent(connection: LbugConnectionLike, table: string, file: string, columns: readonly string[], from: string, to: string): Promise<void> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
  // Relationship endpoints are the first two input columns but are not named
  // relationship properties in COPY's optional column list.
  await query(connection, `COPY ${table}(${columns.slice(2).join(',')}) FROM ${literal(file)} (AUTO_DETECT=false, PARALLEL=false, NULL_STRINGS=[${literal(NULL)}], FROM=${literal(from)}, TO=${literal(to)})`);
}

async function updateArrays(connection: LbugConnectionLike, table: string, rows: object[], keys: string[]): Promise<void> {
  if (rows.length === 0) return;
  const statement = await connection.prepare(`UNWIND $rows AS row MATCH (n:${table} {id: row.id}) SET ${keys.map((key) => `n.${key}=row.${key}`).join(',')}`);
  await close(await connection.execute(statement, { rows }));
}

async function createResolutionLinks(connection: LbugConnectionLike, values: Iterable<JvmClassResolution>): Promise<void> {
  const rows = [...values].map((value) => ({ ...value, id: `resolved-reference:${value.binaryName}` }));
  for (let index = 0; index < rows.length; index += 1000) {
    const statement = await connection.prepare('UNWIND $rows AS row MATCH (c:JvmClass {id:row.classId}),(r:JvmBinaryReference {binaryName:row.binaryName}) CREATE (c)-[:JvmResolvedReference {id:row.id,stageId:row.stageId}]->(r)');
    await close(await connection.execute(statement, { rows: rows.slice(index, index + 1000) }));
  }
}

async function* readBatches(file: string): AsyncIterable<JvmArtifactBatch> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as JvmArtifactBatch;
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return NULL;
  const text = typeof value === 'boolean' ? String(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function safeName(value: string): string { return Buffer.from(value).toString('base64url'); }
function atomicJson(file: string, value: unknown): void { const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
function mergeBatch(target: JvmArtifactBatch, source: JvmArtifactBatch): void { for (const key of Object.keys(target) as Array<keyof JvmArtifactBatch>) (target[key] as unknown[]).push(...source[key] as unknown[]); }
async function query(connection: LbugConnectionLike, text: string): Promise<void> { await close(await connection.query(text)); }
async function close(result: LbugQueryResultLike | LbugQueryResultLike[]): Promise<void> { for (const value of Array.isArray(result) ? result : [result]) await value.close?.(); }
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}
