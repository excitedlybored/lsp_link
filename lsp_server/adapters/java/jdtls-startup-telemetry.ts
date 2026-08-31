import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export type JdtlsStartupStatus = 'complete' | 'failed';

export interface JdtlsProcessMetadata {
  processId?: number;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  processStderrTail?: string;
}

export interface JdtlsClasspathReadinessProgress {
  attempts: number;
  totalRoots: number;
  completedRoots: number;
  currentRootId?: string;
  expectedEntries: number;
  classpathEntries: number;
  modulepathEntries: number;
  actualEntries: number;
  matchedEntries: number;
  missingEntries: number;
  lastProgressAt: number;
  requestState?: 'sent' | 'returned' | 'failed';
  requestElapsedMs?: number;
  lastError?: string;
}

export interface JdtlsStartupTelemetryOptions {
  shardId: string;
  sourceFileCount: number;
  classpathEntryCount: number;
  heapXmx: string;
  timeoutMs: number;
  heartbeatMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  processMetadata?: () => JdtlsProcessMetadata;
  processRssMiB?: (pid: number) => number | undefined;
}

/** One deadline and one heartbeat stream cover the complete JDT startup path. */
export class JdtlsStartupTelemetry {
  public readonly startedAt: number;
  public readonly deadlineAt: number;

  private phase = 'created';
  private pendingRoots = 0;
  private classpathReadiness?: JdtlsClasspathReadinessProgress;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly processRss: (pid: number) => number | undefined;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly options: JdtlsStartupTelemetryOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
    this.processRss = options.processRssMiB ?? readProcessRssMiB;
    this.heartbeatMs = options.heartbeatMs ?? jdtlsStartupHeartbeatMs();
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs < 1) {
      throw new Error('JDT startup heartbeat must be a positive number');
    }
    this.startedAt = this.now();
    this.deadlineAt = this.startedAt + options.timeoutMs;
  }

  start(): void {
    this.report('start');
    this.heartbeat = setInterval(() => this.report('heartbeat'), this.heartbeatMs);
    this.heartbeat.unref();
  }

  setPhase(phase: string): void {
    this.phase = phase;
    this.report('phase');
  }

  setPendingRoots(count: number): void {
    this.pendingRoots = count;
  }

  setClasspathReadiness(progress: JdtlsClasspathReadinessProgress): void {
    this.classpathReadiness = { ...progress };
    this.pendingRoots = Math.max(0, progress.totalRoots - progress.completedRoots);
  }

  remainingMs(phase = this.phase): number {
    const remaining = this.deadlineAt - this.now();
    if (remaining <= 0) {
      throw new Error(
        `[${this.options.shardId}] JDT startup deadline exceeded during ${phase} `
        + `after ${formatDuration(this.now() - this.startedAt)}`,
      );
    }
    return remaining;
  }

  finish(status: JdtlsStartupStatus, reason?: string): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.report(status, reason);
  }

  /** Exposed for deterministic tests without waiting for the real interval. */
  reportHeartbeat(): void {
    this.report('heartbeat');
  }

  private report(event: 'start' | 'phase' | 'heartbeat' | JdtlsStartupStatus, reason?: string): void {
    const metadata = this.options.processMetadata?.() ?? {};
    const processId = metadata.processId;
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    const remainingMs = Math.max(0, this.deadlineAt - this.now());
    const nodeRssMiB = bytesToMiB(process.memoryUsage().rss);
    const jdtRssMiB = processId === undefined ? undefined : this.processRss(processId);
    let classpathReadiness: Record<string, unknown> | undefined;
    if (this.classpathReadiness) {
      const { lastProgressAt, ...progress } = this.classpathReadiness;
      classpathReadiness = {
        ...progress,
        rootProgressPercent: percentage(progress.completedRoots, progress.totalRoots),
        entryProgressPercent: percentage(progress.matchedEntries, progress.expectedEntries),
        stalledForMs: Math.max(0, this.now() - lastProgressAt),
      };
    }
    this.log(`[jdtls-startup] ${JSON.stringify({
      event,
      shardId: this.options.shardId,
      phase: this.phase,
      elapsedMs,
      remainingMs,
      sourceFiles: this.options.sourceFileCount,
      classpathEntries: this.options.classpathEntryCount,
      pendingRoots: this.pendingRoots,
      classpathReadiness,
      heapXmx: this.options.heapXmx,
      processId,
      processExitCode: metadata.processExitCode ?? undefined,
      processSignal: metadata.processSignal ?? undefined,
      nodeRssMiB,
      jdtRssMiB,
      reason,
    })}`);
  }
}

export function jdtlsStartupTimeoutMs(
  sourceFileCount: number,
  classpathEntryCount: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = environment.GITNEXUS_JDT_STARTUP_TIMEOUT_MS
    ?? environment.GITNEXUS_JDT_CLASSPATH_READY_TIMEOUT_MS;
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('GITNEXUS_JDT_STARTUP_TIMEOUT_MS must be a positive number');
    }
    return parsed;
  }
  const scaled = 60_000 + sourceFileCount * 50 + classpathEntryCount * 150;
  return Math.min(15 * 60_000, Math.max(3 * 60_000, scaled));
}

export function jdtlsStartupHeartbeatMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.GITNEXUS_JDT_STARTUP_HEARTBEAT_MS;
  if (configured === undefined) return 15_000;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('GITNEXUS_JDT_STARTUP_HEARTBEAT_MS must be a positive number');
  }
  return parsed;
}

function readProcessRssMiB(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) return roundMiB(Number(match[1]) / 1024);
    } catch { return undefined; }
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const output = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1_000,
      }).trim();
      const kib = Number(output);
      return Number.isFinite(kib) ? roundMiB(kib / 1024) : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function bytesToMiB(value: number): number {
  return roundMiB(value / 1024 / 1024);
}

function roundMiB(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentage(completed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round(Math.max(0, Math.min(1, completed / total)) * 10_000) / 100;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}
