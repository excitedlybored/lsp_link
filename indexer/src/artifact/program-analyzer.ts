import path from 'node:path';
import fs from 'node:fs';
import { globSync } from 'glob';
import {
  AsmArtifactWorker,
  type JvmArtifactAnalysisRequest,
  type JvmArtifactAnalysisResult,
  type JvmProgramFactBatch,
  type JvmProgramAnalyzerInfo,
  type JvmWorkerLaunch,
} from './asm-worker.js';

export type JvmAnalyzerProvider = 'asm' | 'sootup';

/** Provider-neutral, bounded streaming boundary for JVM program analysis. */
export interface JvmProgramAnalyzer {
  readonly provider: JvmAnalyzerProvider;
  start(): Promise<JvmProgramAnalyzerInfo>;
  analyzeArtifact(
    request: JvmArtifactAnalysisRequest,
    onBatch?: (batch: JvmProgramFactBatch) => void | Promise<void>,
  ): Promise<JvmArtifactAnalysisResult>;
  close(): Promise<void>;
  cancel(): void;
}

class WorkerProgramAnalyzer implements JvmProgramAnalyzer {
  private readonly worker: AsmArtifactWorker;

  constructor(
    readonly provider: JvmAnalyzerProvider,
    concurrency: number,
    launch?: JvmWorkerLaunch,
  ) {
    this.worker = new AsmArtifactWorker(concurrency, launch);
  }

  start(): Promise<JvmProgramAnalyzerInfo> { return this.worker.start(); }
  analyzeArtifact(
    request: JvmArtifactAnalysisRequest,
    onBatch?: (batch: JvmProgramFactBatch) => void | Promise<void>,
  ): Promise<JvmArtifactAnalysisResult> { return this.worker.analyzeArtifact(request, onBatch); }
  close(): Promise<void> { return this.worker.close(); }
  cancel(): void { this.worker.cancel(); }
}

export class AsmProgramAnalyzer extends WorkerProgramAnalyzer {
  constructor(concurrency = 4) { super('asm', concurrency); }
}

export class SootUpProgramAnalyzer extends WorkerProgramAnalyzer {
  constructor(concurrency = 4, repository = findRepositoryRoot()) {
    super('sootup', concurrency, sootUpLaunch(repository));
  }
}

/** Sample-only comparison runner that gives both providers identical inputs. */
export class ComparisonProgramAnalyzer {
  constructor(
    readonly baseline: JvmProgramAnalyzer,
    readonly candidate: JvmProgramAnalyzer,
  ) {}

  async start(): Promise<void> {
    await Promise.all([this.baseline.start(), this.candidate.start()]);
  }

  async analyzeArtifact(request: JvmArtifactAnalysisRequest): Promise<{
    baseline: JvmProgramFactBatch[]; candidate: JvmProgramFactBatch[];
  }> {
    const baseline: JvmProgramFactBatch[] = [];
    const candidate: JvmProgramFactBatch[] = [];
    await Promise.all([
      this.baseline.analyzeArtifact(request, (batch) => { baseline.push(batch); }),
      this.candidate.analyzeArtifact(request, (batch) => { candidate.push(batch); }),
    ]);
    return { baseline, candidate };
  }

  async close(): Promise<void> {
    await Promise.all([this.baseline.close(), this.candidate.close()]);
  }
}

export function createJvmProgramAnalyzer(
  provider: JvmAnalyzerProvider,
  concurrency: number,
): JvmProgramAnalyzer {
  return provider === 'sootup'
    ? new SootUpProgramAnalyzer(concurrency)
    : new AsmProgramAnalyzer(concurrency);
}

function sootUpLaunch(repository: string): JvmWorkerLaunch {
  const worker = process.env.GITNEXUS_SOOTUP_WORKER_JAR
    ?? path.join(repository, 'dist/sootup-worker/gitnexus-sootup-worker.jar');
  const dependencies = process.env.GITNEXUS_SOOTUP_CLASSPATH
    ? process.env.GITNEXUS_SOOTUP_CLASSPATH.split(path.delimiter).filter(Boolean)
    : globSync(path.join(repository, 'vendor/sootup/2.0.0/*.jar')).sort();
  return {
    provider: 'sootup', label: 'SootUp',
    mainClass: 'io.gitnexus.sootup.SootUpWorker',
    classpath: [worker, ...dependencies],
  };
}

function findRepositoryRoot(): string {
  let candidate = path.resolve(process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(candidate, 'package.json'))
      && fs.existsSync(path.join(candidate, 'vendor'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Could not locate the GitNexus repository root');
    candidate = parent;
  }
}
