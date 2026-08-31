import assert from 'node:assert/strict';
import test from 'node:test';

import { withMemoryTelemetry } from '../src/telemetry/memory.js';

test('emits machine-readable RSS measurements before and after a successful stage', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(' '));
  try {
    const result = await withMemoryTelemetry(
      'test-stage', async () => 42, { graph: 'test' },
    );
    assert.equal(result, 42);
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 2);
  const start = record(lines[0]!);
  const end = record(lines[1]!);
  assert.deepEqual(start.attributes, { graph: 'test' });
  assert.equal(start.event, 'start');
  assert.equal(end.event, 'end');
  assert.equal(end.status, 'complete');
  assert.equal(end.rssDeltaBytes, end.rssAfterBytes - end.rssBeforeBytes);
  assert.ok(end.peakRssBytes >= end.rssBeforeBytes);
  assert.ok(end.peakRssBytes >= end.rssAfterBytes);
  assert.ok(end.elapsedMs >= 0);
});

test('records a failed stage and preserves the original error', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(' '));
  try {
    await assert.rejects(
      withMemoryTelemetry('failing-stage', async () => { throw new Error('expected'); }),
      /expected/,
    );
  } finally {
    console.log = original;
  }
  assert.equal(record(lines[1]!).status, 'failed');
});

function record(line: string): Record<string, any> {
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, any>;
}
