import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { globSync } from 'glob';

const PROTOCOL_VERSION = 1;
const ASM_HASH = '6f3828a215c920059a5efa2fb55c233d6c54ec5cadca99ce1b1bdd10077c7ddd';

export interface AsmClassFact {
  factType: 'class';
  artifactId: string;
  binaryName: string;
  classFileMajor: number;
  kind: 'class' | 'interface' | 'enum' | 'annotation' | 'record';
  access: string;
  superName: string | null;
  interfaces: string[];
  annotations: string[];
  detailed: boolean;
}

export interface AsmMethodFact {
  factType: 'method';
  artifactId: string;
  owner: string;
  name: string;
  descriptor: string;
  access: string;
  hasCode: boolean;
  ordinal: number;
  annotations: string[];
}

export interface AsmFieldFact {
  factType: 'field';
  artifactId: string;
  owner: string;
  name: string;
  descriptor: string;
  access: string;
  ordinal: number;
  annotations: string[];
}

export interface AsmCallFact {
  factType: 'call';
  artifactId: string;
  owner: string;
  methodName: string;
  methodDescriptor: string;
  instructionOrdinal: number;
  bytecodeOffset: number;
  opcode: string;
  targetOwner: string;
  targetName: string;
  targetDescriptor: string;
}

export type AsmFact = AsmClassFact | AsmMethodFact | AsmFieldFact | AsmCallFact;

export interface AsmFactBatch {
  artifactId: string;
  sequence: number;
  facts: AsmFact[];
}

export interface AsmArtifactRequest {
  artifactId: string;
  jarPath: string;
  contentHash: string;
  classpathOrdinal: number;
  runtimeMajor: number;
  selectedClasses?: string[];
  analyzeAll?: boolean;
  emitClassFacts?: boolean;
}

export interface AsmArtifactResult {
  artifactId: string;
  classCount: number;
  errorCount: number;
  errors: string[];
}

export interface AsmWorkerInfo {
  protocolVersion: number;
  provider: 'asm';
  providerVersion: string;
  javaVersion: string;
  runtimeMajor: number;
  minimumClassFileMajor: number;
  maximumClassFileMajor: number;
  concurrency: number;
}

export class AsmWorkerProcessError extends Error {}
export class AsmArtifactAnalysisError extends Error {}

interface PendingArtifact {
  onBatch?: (batch: AsmFactBatch) => void | Promise<void>;
  errors: string[];
  chain: Promise<void>;
  nextSequence: number;
  resolve: (result: AsmArtifactResult) => void;
  reject: (error: Error) => void;
}

/** One persistent, backpressured JVM worker for an entire enrichment run. */
export class AsmArtifactWorker {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingArtifact>();
  private hello?: { resolve: (info: AsmWorkerInfo) => void; reject: (error: Error) => void };
  private closed = false;
  private exited = false;
  private stderr = '';

  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error(`ASM worker concurrency must be an integer from 1 to 16, got ${concurrency}`);
    }
  }

  async start(): Promise<AsmWorkerInfo> {
    if (this.process) throw new Error('ASM worker is already started');
    const repository = findRepositoryRoot();
    const workerJar = process.env.GITNEXUS_ASM_WORKER_JAR
      ?? path.join(repository, 'dist/jvm-artifact-worker/gitnexus-artifact-worker.jar');
    const asmJar = process.env.GITNEXUS_ASM_JAR
      ?? path.join(repository, 'vendor/jdtls/1.57.0/plugins/org.objectweb.asm_9.9.1.jar');
    for (const required of [workerJar, asmJar]) {
      if (!fs.existsSync(required)) throw new Error(`ASM worker dependency is missing: ${required}; run npm run build`);
    }
    const java = locateJavaExecutable();
    const child = spawn(java, [
      '-cp', [workerJar, asmJar].join(path.delimiter),
      'io.gitnexus.artifact.ArtifactWorker',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-64 * 1024);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      this.exited = true;
      if (!this.closed) this.failAll(new AsmWorkerProcessError(
        `ASM worker exited unexpectedly (${signal ?? code ?? 'unknown'})${this.stderr ? `: ${this.stderr.trim()}` : ''}`,
      ));
    });
    const lines = readline.createInterface({ input: child.stdout });
    void this.consumeLines(lines);
    const info = new Promise<AsmWorkerInfo>((resolve, reject) => { this.hello = { resolve, reject }; });
    await this.write({ type: 'hello', protocolVersion: PROTOCOL_VERSION, concurrency: this.concurrency });
    const result = await info;
    if (result.protocolVersion !== PROTOCOL_VERSION || result.provider !== 'asm') {
      throw new Error(`Unsupported ASM worker handshake: ${JSON.stringify(result)}`);
    }
    if (result.runtimeMajor < 21) {
      await this.close();
      throw new Error(`ASM artifact enrichment requires JDK 21+, got Java ${result.javaVersion}`);
    }
    return result;
  }

  async analyzeArtifact(
    request: AsmArtifactRequest,
    onBatch?: (batch: AsmFactBatch) => void | Promise<void>,
  ): Promise<AsmArtifactResult> {
    if (!this.process || this.closed) throw new Error('ASM worker is not running');
    if (this.pending.has(request.artifactId)) throw new Error(`Artifact is already active: ${request.artifactId}`);
    const completion = new Promise<AsmArtifactResult>((resolve, reject) => {
      this.pending.set(request.artifactId, {
        onBatch, errors: [], chain: Promise.resolve(), nextSequence: 0, resolve, reject,
      });
    });
    await this.write({ type: 'analyzeArtifact', ...request });
    return completion;
  }

  async close(): Promise<void> {
    if (!this.process || this.closed) return;
    this.closed = true;
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.process!.once('exit', () => resolve()));
    await this.write({ type: 'shutdown' });
    if (!this.exited) await exited;
  }

  /** Cancel the active run by terminating the worker; pending requests reject uniformly. */
  cancel(): void {
    if (!this.process || this.exited) return;
    this.process.kill('SIGTERM');
  }

  private async consumeLine(line: string): Promise<void> {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { return this.failAll(new Error(`ASM worker emitted invalid NDJSON: ${line.slice(0, 500)}`)); }
    if (message.type === 'hello') {
      this.hello?.resolve(message as unknown as AsmWorkerInfo);
      this.hello = undefined;
      return;
    }
    const artifactId = typeof message.artifactId === 'string' ? message.artifactId : undefined;
    const pending = artifactId ? this.pending.get(artifactId) : undefined;
    if (message.type === 'batch' && pending) {
      const batch = message as unknown as AsmFactBatch;
      if (batch.sequence !== pending.nextSequence) {
        return this.failAll(new Error(
          `ASM protocol sequence mismatch for ${artifactId}: expected ${pending.nextSequence}, got ${batch.sequence}`,
        ));
      }
      if (!Array.isArray(batch.facts) || batch.facts.length > 500 || Buffer.byteLength(line, 'utf8') > 1024 * 1024) {
        return this.failAll(new Error(`ASM worker exceeded the negotiated batch bound for ${artifactId}`));
      }
      pending.nextSequence += 1;
      pending.chain = pending.chain.then(async () => pending.onBatch?.(batch));
      await pending.chain;
      return;
    }
    if (message.type === 'error') {
      const error = new AsmArtifactAnalysisError(String(message.message ?? 'unknown ASM worker error'));
      if (pending && message.fatal === true) {
        try { await pending.chain; }
        catch (callbackError) {
          pending.reject(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
          this.pending.delete(artifactId!);
          return;
        }
        pending.reject(error);
        this.pending.delete(artifactId!);
      } else if (pending) pending.errors.push(error.message);
      else this.failAll(error);
      return;
    }
    if (message.type === 'artifactComplete' && pending) {
      if (Number(message.sequence) !== pending.nextSequence) {
        return this.failAll(new Error(
          `ASM completion sequence mismatch for ${artifactId}: expected ${pending.nextSequence}, got ${message.sequence}`,
        ));
      }
      try { await pending.chain; }
      catch (callbackError) {
        pending.reject(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
        this.pending.delete(artifactId!);
        return;
      }
      pending.resolve({
        artifactId: artifactId!,
        classCount: Number(message.classCount ?? 0),
        errorCount: Number(message.errorCount ?? pending.errors.length),
        errors: pending.errors,
      });
      this.pending.delete(artifactId!);
    }
  }

  private async consumeLines(lines: readline.Interface): Promise<void> {
    try {
      for await (const line of lines) await this.consumeLine(line);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async write(value: unknown): Promise<void> {
    const stream = this.process?.stdin;
    if (!stream || stream.destroyed) throw new Error('ASM worker stdin is unavailable');
    const line = `${JSON.stringify(value)}\n`;
    if (!stream.write(line, 'utf8')) await new Promise<void>((resolve) => stream.once('drain', resolve));
  }

  private failAll(error: Error): void {
    this.hello?.reject(error);
    this.hello = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function findRepositoryRoot(): string {
  let candidate = path.resolve(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(candidate, 'package.json'))
      && fs.existsSync(path.join(candidate, 'vendor/jdtls'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Could not locate the GitNexus repository root');
    candidate = parent;
  }
}

function locateJavaExecutable(): string {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const configuredHome = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
  if (configuredHome) return path.join(configuredHome, 'bin', executable);
  const candidates = process.platform === 'win32'
    ? globSync(path.join(os.homedir(), '.jdks/*/bin/java.exe'))
    : [
        ...globSync('/usr/lib/jvm/*/bin/java'),
        ...globSync('/opt/homebrew/opt/openjdk@21/bin/java'),
        ...globSync('/opt/homebrew/opt/openjdk/bin/java'),
        ...globSync(path.join(os.homedir(), '.local/jdks/*/bin/java')),
        ...globSync(path.join(os.homedir(), 'Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java')),
      ];
  return candidates[0] ?? executable;
}

export const ASM_CORE_SHA256 = ASM_HASH;
