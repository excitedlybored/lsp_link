export interface JavapDisassemblyProgress {
  completedClasses: number;
  totalClasses: number;
  successfulClasses: number;
  failedClasses: number;
  concurrency: number;
  elapsedMs: number;
  done: boolean;
}

export interface JavapDisassemblyQueueOptions {
  initialNames: string[];
  maxClasses: number;
  concurrency: number;
  batchSize?: number;
  progressIntervalMs?: number;
  executeBatch: (names: string[]) => Promise<string>;
  consumeOutput: (output: string) => Iterable<string>;
  onBatchFailure?: (names: string[], error: unknown) => void;
  onProgress?: (progress: JavapDisassemblyProgress) => void;
}

export interface JavapDisassemblyQueueResult {
  visited: Set<string>;
  successfulClasses: number;
  failedClasses: number;
  truncated: boolean;
}

/**
 * Convert physical JAR entries into the logical binary entries visible to the
 * active Java runtime. Multi-release variants collapse onto the same class;
 * javap selects the effective bytecode from the JAR at load time.
 */
export function normalizeJarClassEntries(entries: string[], runtimeMajor?: number): string[] {
  const logicalEntries = new Set<string>();
  for (const entry of entries) {
    const versioned = entry.match(/^META-INF\/versions\/(\d+)\/(.+\.class)$/);
    if (versioned) {
      const version = Number(versioned[1]);
      if (runtimeMajor !== undefined && version > runtimeMajor) continue;
      logicalEntries.add(versioned[2]!);
      continue;
    }
    if (entry.startsWith('META-INF/')) continue;
    if (entry.endsWith('.class')) logicalEntries.add(entry);
  }
  return [...logicalEntries].sort();
}

/**
 * Execute javap concurrently, then consume each wave in input order. Parsing
 * remains deterministic and never mutates a shared graph batch concurrently.
 */
export async function disassembleClassQueue(
  options: JavapDisassemblyQueueOptions,
): Promise<JavapDisassemblyQueueResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(`javap concurrency must be a positive integer, got ${options.concurrency}`);
  }
  const batchSize = options.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`javap batch size must be a positive integer, got ${batchSize}`);
  }
  const progressIntervalMs = options.progressIntervalMs ?? 5_000;
  const queue = [...new Set(options.initialNames)];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let successfulClasses = 0;
  let failedClasses = 0;

  const totalClasses = (): number => Math.min(
    options.maxClasses,
    visited.size + [...queued].filter((name) => !visited.has(name)).length,
  );
  const report = (done: boolean, force = false): void => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = now;
    options.onProgress({
      completedClasses: successfulClasses + failedClasses,
      totalClasses: totalClasses(),
      successfulClasses,
      failedClasses,
      concurrency: options.concurrency,
      elapsedMs: now - startedAt,
      done,
    });
  };
  report(false, true);

  while (queue.length > 0 && visited.size < options.maxClasses) {
    const wave: string[][] = [];
    while (wave.length < options.concurrency && queue.length > 0 && visited.size < options.maxClasses) {
      const names: string[] = [];
      while (names.length < batchSize && queue.length > 0 && visited.size < options.maxClasses) {
        const name = queue.shift()!;
        queued.delete(name);
        if (visited.has(name)) continue;
        visited.add(name);
        names.push(name);
      }
      if (names.length > 0) wave.push(names);
    }
    const results = await Promise.all(wave.map(async (names) => {
      try {
        return { names, output: await options.executeBatch(names) };
      } catch (error) {
        return { names, error };
      }
    }));
    for (const result of results) {
      if ('error' in result) {
        failedClasses += result.names.length;
        options.onBatchFailure?.(result.names, result.error);
        continue;
      }
      successfulClasses += result.names.length;
      for (const target of options.consumeOutput(result.output)) {
        if (visited.has(target) || queued.has(target)) continue;
        queue.push(target);
        queued.add(target);
      }
    }
    report(false);
  }

  const truncated = queue.length > 0;
  report(true, true);
  return { visited, successfulClasses, failedClasses, truncated };
}
