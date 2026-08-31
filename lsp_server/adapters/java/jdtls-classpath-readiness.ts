import * as fs from 'fs';
import * as path from 'path';
import type { ILspAdapter } from '../../contracts/lsp-adapter.interface.js';
import type { PreparedJdtlsShard } from './jdtls-sharding.js';
import type { JdtlsClasspathReadinessProgress } from './jdtls-startup-telemetry.js';

export interface JdtlsClasspathReadinessOptions {
  stallTimeoutMs?: number;
  maxConsecutiveErrors?: number;
  initialPollMs?: number;
  maxPollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * ServiceReady precedes completion of Eclipse project import. This gate waits
 * for every expected classpath entry before a shard is exposed to crawlers.
 */
export async function waitForImportedJavaProjects(
  adapter: ILspAdapter,
  projectModels: PreparedJdtlsShard['projectModels'],
  shardId: string,
  deadlineAt?: number,
  onPendingRoots?: (count: number) => void,
  onProgress?: (progress: JdtlsClasspathReadinessProgress) => void,
  options: JdtlsClasspathReadinessOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const stallTimeoutMs = options.stallTimeoutMs ?? positiveReadinessInteger(
    process.env.GITNEXUS_JDT_CLASSPATH_STALL_TIMEOUT_MS, 30_000,
    'GITNEXUS_JDT_CLASSPATH_STALL_TIMEOUT_MS',
  );
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? positiveReadinessInteger(
    process.env.GITNEXUS_JDT_CLASSPATH_MAX_ERRORS, 3,
    'GITNEXUS_JDT_CLASSPATH_MAX_ERRORS',
  );
  const initialPollMs = options.initialPollMs ?? 500;
  const maxPollMs = options.maxPollMs ?? 5_000;
  const deadline = deadlineAt ?? now() + 180_000;
  const pending = new Map(projectModels
    .filter((model) => model.representativeDocumentPath)
    .map((model) => [model.buildRootId, model]));
  const totalRoots = pending.size;
  const expectedByRoot = new Map([...pending].map(([rootId, model]) => {
    const expected = new Map<string, string>();
    for (const entry of model.languageServerClasspath) {
      const resolved = path.resolve(entry);
      expected.set(classpathReadinessKey(resolved), resolved);
    }
    return [rootId, expected];
  }));
  const bestMatchedByRoot = new Map<string, number>();
  const bestActualByRoot = new Map<string, number>();
  const lastProgressByRoot = new Map<string, number>();
  const consecutiveErrorsByRoot = new Map<string, number>();
  let attempts = 0;
  let lastProgressAt = now();
  let pollMs = initialPollMs;
  onPendingRoots?.(pending.size);
  do {
    let madeProgress = false;
    for (const [rootId, model] of pending) {
      if (now() >= deadline) break;
      attempts += 1;
      try {
        const response = await adapter.request<{ classpaths?: unknown; modulepaths?: unknown }>('workspace/executeCommand', {
          command: 'java.project.getClasspaths',
          arguments: [adapter.documentUri(model.representativeDocumentPath!), JSON.stringify({ scope: 'runtime' })],
        });
        const classpaths = stringPaths(response.classpaths);
        const modulepaths = stringPaths(response.modulepaths);
        const actual = new Set([...classpaths, ...modulepaths].map(classpathReadinessKey));
        const expected = expectedByRoot.get(rootId) ?? new Map<string, string>();
        const missing = [...expected].filter(([key]) => !actual.has(key)).map(([, original]) => original);
        const matchedEntries = expected.size - missing.length;
        if (matchedEntries > (bestMatchedByRoot.get(rootId) ?? -1)
          || actual.size > (bestActualByRoot.get(rootId) ?? -1)) {
          bestMatchedByRoot.set(rootId, matchedEntries);
          bestActualByRoot.set(rootId, actual.size);
          lastProgressAt = now();
          lastProgressByRoot.set(rootId, lastProgressAt);
          madeProgress = true;
        }
        consecutiveErrorsByRoot.set(rootId, 0);
        if (missing.length === 0) {
          pending.delete(rootId);
          onPendingRoots?.(pending.size);
        }
        onProgress?.({
          attempts,
          totalRoots,
          completedRoots: totalRoots - pending.size,
          currentRootId: rootId,
          expectedEntries: expected.size,
          classpathEntries: classpaths.length,
          modulepathEntries: modulepaths.length,
          actualEntries: actual.size,
          matchedEntries,
          missingEntries: missing.length,
          lastProgressAt,
        });
        const stalledForMs = now() - (lastProgressByRoot.get(rootId) ?? lastProgressAt);
        if (missing.length > 0 && stalledForMs >= stallTimeoutMs) {
          throw new JdtlsStableClasspathMismatchError(
            `[${shardId}] JDT classpath for ${rootId} stopped progressing for ${stalledForMs} ms: `
            + `${missing.length}/${expected.size} Bazel entries are missing. `
            + `Missing sample: ${missing.slice(0, 10).join(', ')}`,
          );
        }
      } catch (error) {
        if (error instanceof JdtlsStableClasspathMismatchError) throw error;
        const message = (error instanceof Error ? error.message : String(error)).slice(-500);
        const transientImportError = isTransientJdtImportError(message);
        const consecutiveErrors = transientImportError
          ? 0
          : (consecutiveErrorsByRoot.get(rootId) ?? 0) + 1;
        consecutiveErrorsByRoot.set(rootId, consecutiveErrors);
        onProgress?.({
          attempts,
          totalRoots,
          completedRoots: totalRoots - pending.size,
          currentRootId: rootId,
          expectedEntries: model.languageServerClasspath.length,
          classpathEntries: 0,
          modulepathEntries: 0,
          actualEntries: 0,
          matchedEntries: bestMatchedByRoot.get(rootId) ?? 0,
          missingEntries: Math.max(0, model.languageServerClasspath.length - (bestMatchedByRoot.get(rootId) ?? 0)),
          lastProgressAt,
          lastError: message,
        });
        const stalledForMs = now() - (lastProgressByRoot.get(rootId) ?? lastProgressAt);
        if (transientImportError && stalledForMs >= stallTimeoutMs) {
          throw new Error(
            `[${shardId}] JDT project import for ${rootId} remained unavailable for ${stalledForMs} ms: ${message}`,
          );
        }
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `[${shardId}] JDT classpath validation failed ${consecutiveErrors} consecutive times for ${rootId}: ${message}`,
          );
        }
      }
    }
    if (pending.size === 0) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    pollMs = madeProgress ? initialPollMs : Math.min(maxPollMs, pollMs * 2);
  } while (now() < deadline);
  if (pending.size > 0) {
    throw new Error(
      `[${shardId}] JDT classpath readiness timed out with ${pending.size} pending roots: `
      + [...pending.keys()].join(', '),
    );
  }
}

class JdtlsStableClasspathMismatchError extends Error {}

function isTransientJdtImportError(message: string): boolean {
  return /references non-existing project|project [^\n]+ (?:does not exist|is not accessible)/i.test(message);
}

function positiveReadinessInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => path.resolve(entry))
    : [];
}

function classpathReadinessKey(value: string): string {
  const resolved = path.resolve(value);
  let canonical = resolved;
  try { canonical = fs.realpathSync(resolved); } catch { /* retain the reported path */ }
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}
