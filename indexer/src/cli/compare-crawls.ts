import fs from 'node:fs';
import path from 'node:path';
import { deserialize } from 'node:v8';
import type { LspObservationBatch } from '../ingest/batch.js';
import { compareCrawlSemanticInventories } from '../ingest/semantic-inventory.js';

interface CheckpointEnvelope {
  formatVersion: number;
  stage: string;
  fingerprint: string;
  payload?: { lspBatch?: LspObservationBatch };
}

function main(argv: string[]): void {
  const [originalPath, candidatePath, ...rest] = argv;
  if (!originalPath || !candidatePath) {
    throw new Error(
      'Usage: compare:crawls ORIGINAL_LSP_CRAWL_CHECKPOINT CANDIDATE_LSP_CRAWL_CHECKPOINT [--output PATH]',
    );
  }
  let outputPath: string | undefined;
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--output') {
      const value = rest.shift();
      if (!value || value.startsWith('--')) throw new Error('--output requires a value');
      outputPath = path.resolve(value);
    } else {
      throw new Error(`Unknown argument ${flag}`);
    }
  }

  const original = loadCrawlBatch(originalPath);
  const candidate = loadCrawlBatch(candidatePath);
  const comparison = compareCrawlSemanticInventories(original, candidate);
  const report = {
    equivalent: comparison.equivalent,
    original: { checkpoint: path.resolve(originalPath), counts: batchCounts(original) },
    candidate: { checkpoint: path.resolve(candidatePath), counts: batchCounts(candidate) },
    differences: comparison.differences.map((difference) => ({
      category: difference.category,
      missingCount: difference.missing.length,
      unexpectedCount: difference.unexpected.length,
      missingSample: difference.missing.slice(0, 20),
      unexpectedSample: difference.unexpected.slice(0, 20),
    })),
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered);
    console.log(`Wrote crawl comparison to ${outputPath}`);
  } else {
    process.stdout.write(rendered);
  }
  if (!comparison.equivalent) process.exitCode = 1;
}

function loadCrawlBatch(checkpointPath: string): LspObservationBatch {
  const resolved = path.resolve(checkpointPath);
  if (!fs.existsSync(resolved)) throw new Error(`Crawl checkpoint does not exist: ${resolved}`);
  const envelope = deserialize(fs.readFileSync(resolved)) as CheckpointEnvelope;
  if (envelope.formatVersion !== 1 || envelope.stage !== 'lsp-crawl' || !envelope.payload?.lspBatch) {
    throw new Error(`Not a supported lsp-crawl checkpoint: ${resolved}`);
  }
  return envelope.payload.lspBatch;
}

function batchCounts(batch: LspObservationBatch): Record<keyof LspObservationBatch, number> {
  return Object.fromEntries(
    Object.entries(batch).map(([key, values]) => [key, values.length]),
  ) as Record<keyof LspObservationBatch, number>;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
