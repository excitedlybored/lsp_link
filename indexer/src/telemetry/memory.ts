/** Lightweight, machine-readable RSS telemetry for expensive pipeline stages. */

export type MemoryTelemetryStatus = 'complete' | 'failed';

export interface MemoryTelemetryAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

export interface MemoryTelemetryMeasurement {
  stage: string;
  status: MemoryTelemetryStatus;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssDeltaBytes: number;
  peakRssBytes: number;
  elapsedMs: number;
  attributes: MemoryTelemetryAttributes;
}

export interface MemoryTelemetryHandle {
  end(status?: MemoryTelemetryStatus): MemoryTelemetryMeasurement;
}

const SAMPLE_INTERVAL_MS = 100;

export function startMemoryTelemetry(
  stage: string,
  attributes: MemoryTelemetryAttributes = {},
): MemoryTelemetryHandle {
  const startedAt = performance.now();
  const rssBeforeBytes = currentRss();
  let peakRssBytes = rssBeforeBytes;
  let ended = false;
  let measurement: MemoryTelemetryMeasurement | undefined;
  console.log(`[memory:${stage}] ${JSON.stringify({
    event: 'start', rssBytes: rssBeforeBytes, rssMiB: toMiB(rssBeforeBytes), attributes,
  })}`);
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, currentRss());
  }, SAMPLE_INTERVAL_MS);
  sampler.unref();

  return {
    end(status = 'complete') {
      if (ended) return measurement!;
      ended = true;
      clearInterval(sampler);
      const rssAfterBytes = currentRss();
      peakRssBytes = Math.max(peakRssBytes, rssAfterBytes);
      measurement = {
        stage,
        status,
        rssBeforeBytes,
        rssAfterBytes,
        rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
        peakRssBytes,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
        attributes,
      };
      console.log(`[memory:${stage}] ${JSON.stringify({
        event: 'end', status, rssBeforeBytes, rssAfterBytes,
        rssDeltaBytes: measurement.rssDeltaBytes, peakRssBytes,
        rssBeforeMiB: toMiB(rssBeforeBytes), rssAfterMiB: toMiB(rssAfterBytes),
        rssDeltaMiB: toMiB(measurement.rssDeltaBytes), peakRssMiB: toMiB(peakRssBytes),
        elapsedMs: measurement.elapsedMs, attributes,
      })}`);
      return measurement;
    },
  };
}

export async function withMemoryTelemetry<T>(
  stage: string,
  operation: () => Promise<T>,
  attributes: MemoryTelemetryAttributes = {},
): Promise<T> {
  const telemetry = startMemoryTelemetry(stage, attributes);
  try {
    const result = await operation();
    telemetry.end();
    return result;
  } catch (error) {
    telemetry.end('failed');
    throw error;
  }
}

function currentRss(): number {
  return process.memoryUsage.rss();
}

function toMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
