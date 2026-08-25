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
    if (!fs.existsSync(checkpointPath)) return undefined;
    try {
      const envelope = deserialize(fs.readFileSync(checkpointPath)) as CheckpointEnvelope<T>;
      if (
        envelope.formatVersion !== CHECKPOINT_FORMAT_VERSION
        || envelope.stage !== stage
        || envelope.fingerprint !== fingerprint
      ) {
        console.log(`[checkpoint:${stage}] ignored incompatible checkpoint`);
        return undefined;
      }
      console.log(`[checkpoint:${stage}] resumed from ${checkpointPath}`);
      return envelope.payload;
    } catch (error) {
      console.warn(`[checkpoint:${stage}] ignored unreadable checkpoint: ${errorMessage(error)}`);
      return undefined;
    }
  }

  save<T>(stage: string, fingerprint: string, payload: T): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const checkpointPath = this.pathFor(stage);
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
    console.log(`[checkpoint:${stage}] saved ${checkpointPath}`);
  }

  rootStage(rootId: string): string {
    return `lsp-root-${createHash('sha256').update(rootId).digest('hex').slice(0, 16)}`;
  }

  private pathFor(stage: string): string {
    if (!/^[a-z0-9-]+$/.test(stage)) throw new Error(`Invalid checkpoint stage: ${stage}`);
    return path.join(this.directory, `${stage}.checkpoint`);
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
