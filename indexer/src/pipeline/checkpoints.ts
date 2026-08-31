import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';

const CHECKPOINT_FORMAT_VERSION = 1;

interface CheckpointEnvelope<T> {
  formatVersion: number;
  stage: string;
  fingerprint: string;
  createdAt: string;
  payload: T;
}

export class PipelineCheckpointStore {
  constructor(
    readonly directory: string,
    readonly resume = true,
  ) {}

  load<T>(stage: string, fingerprint: string): T | undefined {
    if (!this.resume) return undefined;
    const checkpointPath = this.pathFor(stage);
    return this.loadPath(stage, fingerprint, checkpointPath, 'checkpoint');
  }

  /** Loads a content-addressed entry without evicting other crawl identities. */
  loadCached<T>(stage: string, cacheId: string): T | undefined {
    if (!this.resume) return undefined;
    return this.loadPath(stage, cacheId, this.cachedPath(stage, cacheId), 'crawl-cache');
  }

  private loadPath<T>(
    stage: string,
    fingerprint: string,
    checkpointPath: string,
    logPrefix: string,
  ): T | undefined {
    if (!fs.existsSync(checkpointPath)) return undefined;
    try {
      const envelope = deserialize(fs.readFileSync(checkpointPath)) as CheckpointEnvelope<T>;
      if (
        envelope.formatVersion !== CHECKPOINT_FORMAT_VERSION
        || envelope.stage !== stage
        || envelope.fingerprint !== fingerprint
      ) {
        console.log(`[${logPrefix}:${stage}] ignored incompatible entry`);
        return undefined;
      }
      console.log(`[${logPrefix}:${stage}] hit ${fingerprint}`);
      return envelope.payload;
    } catch (error) {
      console.warn(`[${logPrefix}:${stage}] ignored unreadable entry: ${errorMessage(error)}`);
      return undefined;
    }
  }

  save<T>(stage: string, fingerprint: string, payload: T, log = true): void {
    this.savePath(stage, fingerprint, payload, this.pathFor(stage), 'checkpoint', log);
  }

  /** Atomically stores a crawl result under its immutable content identity. */
  saveCached<T>(stage: string, cacheId: string, payload: T, log = true): void {
    this.savePath(stage, cacheId, payload, this.cachedPath(stage, cacheId), 'crawl-cache', log);
  }

  private savePath<T>(
    stage: string,
    fingerprint: string,
    payload: T,
    checkpointPath: string,
    logPrefix: string,
    log: boolean,
  ): void {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
    const envelope: CheckpointEnvelope<T> = {
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      stage,
      fingerprint,
      createdAt: new Date().toISOString(),
      payload,
    };
    try {
      fs.writeFileSync(temporaryPath, serialize(envelope));
      fs.renameSync(temporaryPath, checkpointPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
    }
    if (log) console.log(`[${logPrefix}:${stage}] stored ${fingerprint}`);
  }

  rootStage(rootId: string): string {
    return `lsp-root-${createHash('sha256').update(rootId).digest('hex').slice(0, 16)}`;
  }

  private pathFor(stage: string): string {
    validateStage(stage);
    return path.join(this.directory, `${stage}.checkpoint`);
  }

  private cachedPath(stage: string, cacheId: string): string {
    validateStage(stage);
    if (!/^[a-f0-9]{64}$/.test(cacheId)) throw new Error(`Invalid crawl cache ID: ${cacheId}`);
    return path.join(this.directory, 'by-id', stage, `${cacheId}.checkpoint`);
  }
}

export function fingerprintPipelineInputs(
  workspacePath: string,
  inputPaths: string[],
  configuration: unknown,
): string {
  const hash = createHash('sha256');
  hash.update('lsp-knowledge-graph-checkpoint-v1\0');
  hash.update(path.resolve(workspacePath));
  hash.update('\0');
  hash.update(JSON.stringify(configuration));
  for (const inputPath of [...new Set(inputPaths.map((value) => path.resolve(value)))].sort()) {
    hash.update('\0');
    hash.update(path.relative(workspacePath, inputPath));
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(inputPath));
    } catch (error) {
      hash.update(`unreadable:${errorMessage(error)}`);
    }
  }
  return hash.digest('hex');
}

export function combineCheckpointFingerprint(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateStage(stage: string): void {
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error(`Invalid checkpoint stage: ${stage}`);
}
