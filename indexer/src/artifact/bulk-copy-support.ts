import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import type { LbugConnectionLike, LbugQueryResultLike } from '../lbug/repository.js';

const NULL = '__GITNEXUS_NULL_7d35b31b__';
const DEFAULT_ROWS_PER_FILE = 10_000;
const ARRAY_UPDATE_BATCH_SIZE = 1_000;

/** Bounded CSV fragments shared by base-graph and JVM artifact imports. */
export class BulkCsvFiles {
  private readonly descriptors = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly variants = new Map<string, Map<string, { key: string; columns: string[] }>>();

  constructor(
    private readonly directory: string,
    private readonly rowsPerFile = DEFAULT_ROWS_PER_FILE,
  ) {
    if (!Number.isInteger(rowsPerFile) || rowsPerFile < 1) {
      throw new Error(`CSV rows per file must be a positive integer, got ${rowsPerFile}`);
    }
  }

  paths(key: string): string[] {
    const count = this.counts.get(key) ?? 0;
    return Array.from({ length: Math.ceil(count / this.rowsPerFile) }, (_, index) => this.path(key, index));
  }

  fragments(key: string, fallbackColumns: readonly string[]): Array<{ file: string; columns: string[] }> {
    const variants = this.variants.get(key);
    if (!variants) return this.paths(key).map((file) => ({ file, columns: [...fallbackColumns] }));
    return [...variants.values()].flatMap((variant) =>
      this.paths(variant.key).map((file) => ({ file, columns: variant.columns })));
  }

  row(key: string, values: readonly unknown[]): void {
    const count = this.counts.get(key) ?? 0;
    const index = Math.floor(count / this.rowsPerFile);
    const descriptorKey = `${key}\0${index}`;
    let descriptor = this.descriptors.get(descriptorKey);
    if (descriptor === undefined) {
      descriptor = fs.openSync(this.path(key, index), 'a');
      this.descriptors.set(descriptorKey, descriptor);
    }
    fs.writeSync(descriptor, `${values.map(csvValue).join(',')}\n`);
    this.counts.set(key, count + 1);
  }

  object(key: string, value: Record<string, unknown>, columns: readonly string[]): void {
    // Omit nullable properties from COPY rather than relying on CSV null
    // parsing, which differs across Ladybug versions for typed numeric fields.
    const present = columns.filter((column) => value[column] !== null && value[column] !== undefined);
    const signature = present.join('\0');
    let variants = this.variants.get(key);
    if (!variants) {
      variants = new Map();
      this.variants.set(key, variants);
    }
    let variant = variants.get(signature);
    if (!variant) {
      const suffix = createHash('sha256').update(signature).digest('hex').slice(0, 12);
      variant = { key: `${key}-${suffix}`, columns: present };
      variants.set(signature, variant);
    }
    this.row(variant.key, present.map((column) => value[column]));
  }

  close(): void {
    for (const descriptor of this.descriptors.values()) fs.closeSync(descriptor);
    this.descriptors.clear();
  }

  private path(key: string, index: number): string {
    return path.join(this.directory, `${key}.${index}.csv`);
  }
}

export async function copyNodeCsvFragments(
  connection: LbugConnectionLike | (() => LbugConnectionLike),
  csv: BulkCsvFiles,
  key: string,
  table: string,
  columns: readonly string[],
  onCopied?: () => Promise<void>,
): Promise<void> {
  for (const fragment of csv.fragments(key, columns)) {
    await copyIfPresent(
      currentConnection(connection),
      `COPY ${table}(${fragment.columns.join(',')}) FROM ${literal(fragment.file)} `
      + `(AUTO_DETECT=false, PARALLEL=false, NULL_STRINGS=[${literal(NULL)}])`,
      fragment.file,
    );
    await onCopied?.();
  }
}

export async function copyRelationCsvFragments(
  connection: LbugConnectionLike | (() => LbugConnectionLike),
  csv: BulkCsvFiles,
  key: string,
  table: string,
  columns: readonly string[],
  from: string,
  to: string,
  onCopied?: () => Promise<void>,
): Promise<void> {
  for (const fragment of csv.fragments(key, columns)) {
    await copyIfPresent(
      currentConnection(connection),
      `COPY ${table}(${fragment.columns.slice(2).join(',')}) FROM ${literal(fragment.file)} `
      + `(AUTO_DETECT=false, PARALLEL=false, NULL_STRINGS=[${literal(NULL)}], `
      + `FROM=${literal(from)}, TO=${literal(to)})`,
      fragment.file,
    );
    await onCopied?.();
  }
}

/** COPY handles scalar columns; arrays are applied separately without CSV list ambiguity. */
export async function updateArrayProperties(
  connection: LbugConnectionLike,
  table: string,
  rows: Array<Record<string, unknown>>,
  keys: readonly string[],
  propertyTypes: Readonly<Record<string, string>> = {},
): Promise<void> {
  for (let index = 0; index < rows.length; index += ARRAY_UPDATE_BATCH_SIZE) {
    const chunk = rows.slice(index, index + ARRAY_UPDATE_BATCH_SIZE);
    if (chunk.length === 0) continue;
    const statement = await connection.prepare(
      `UNWIND $rows AS row MATCH (n:${table} {id: row.id}) SET `
      + keys.map((key) => {
        const type = propertyTypes[key];
        return `n.${key}=${type ? `CAST(row.${key} AS ${type})` : `row.${key}`}`;
      }).join(','),
    );
    await closeQueryResults(await connection.execute(statement, { rows: chunk }));
  }
}

export async function closeQueryResults(
  result: LbugQueryResultLike | LbugQueryResultLike[],
): Promise<void> {
  for (const value of Array.isArray(result) ? result : [result]) await value.close?.();
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) {
    throw new Error('Bulk CSV rows must omit null properties before encoding');
  }
  return `"${String(value).replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function copyIfPresent(
  connection: LbugConnectionLike,
  query: string,
  file: string,
): Promise<void> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
  await closeQueryResults(await connection.query(query));
}

function currentConnection(
  value: LbugConnectionLike | (() => LbugConnectionLike),
): LbugConnectionLike {
  return typeof value === 'function' ? value() : value;
}
