import type { LbugConnectionLike, LbugPreparedStatementLike, LbugQueryResultLike } from '../lbug/repository.js';
import type { JvmArtifactBatch, JvmEntityKind, JvmRelation } from './model.js';
import { JVM_ARTIFACT_SCHEMA_QUERIES } from './schema.js';

export class JvmArtifactRepository {
  constructor(private readonly connection: LbugConnectionLike) {}

  async initializeSchema(): Promise<void> {
    for (const ddl of JVM_ARTIFACT_SCHEMA_QUERIES) await this.queryAndClose(ddl);
  }

  async writeBatch(batch: JvmArtifactBatch): Promise<void> {
    await this.insertRowsInTransactions('JvmArtifactEnrichmentRun', batch.runs.map(runRow));
    await this.insertRowsInTransactions('JvmArtifact', batch.artifacts.map(artifactRow));
    await this.insertRowsInTransactions('JvmClass', batch.classes.map(classRow));
    await this.insertRowsInTransactions('JvmMethod', batch.methods.map(methodRow));
    await this.insertRowsInTransactions('JvmField', batch.fields.map(fieldRow));
    await this.insertRowsInTransactions('JvmCallSite', batch.callSites);
    for (const chunk of chunks(batch.relations)) {
      await this.inTransaction(async () => {
        for (const relation of chunk) await this.insertRelation(relation);
      });
    }
  }

  private async insertRowsInTransactions(table: JvmEntityKind, rows: Array<object>): Promise<void> {
    for (const chunk of chunks(rows)) await this.inTransaction(() => this.insertRows(table, chunk));
  }

  private async inTransaction(action: () => Promise<void>): Promise<void> {
    await this.queryAndClose('BEGIN TRANSACTION');
    try {
      await action();
      await this.queryAndClose('COMMIT');
    } catch (error) {
      await this.queryAndClose('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async insertRows(table: JvmEntityKind, rows: Array<object>): Promise<void> {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]!);
    const statement = await this.prepare(`CREATE (n:${table} {${keys.map((key) => `${key}: $${key}`).join(', ')}})`);
    for (const row of rows) await closeResults(await this.connection.execute(statement, row as Record<string, unknown>));
  }

  private async insertRelation(value: JvmRelation): Promise<void> {
    const row = {
      from: value.sourceId, to: value.targetId, id: value.id, kind: value.kind,
      stageId: value.stageId, status: value.status, ordinal: value.ordinal ?? null,
    };
    const statement = await this.prepare(
      `MATCH (source:${value.sourceKind} {id: $from}), (target:${value.targetKind} {id: $to}) ` +
      'CREATE (source)-[relation:JvmRelation {id: $id, kind: $kind, stageId: $stageId, status: $status, ordinal: $ordinal}]->(target)',
    );
    await closeResults(await this.connection.execute(statement, row));
  }

  private async prepare(cypher: string): Promise<LbugPreparedStatementLike> {
    const statement = await this.connection.prepare(cypher);
    if (statement.isSuccess && !statement.isSuccess()) {
      throw new Error(`LadybugDB prepare failed: ${statement.getErrorMessage ? await statement.getErrorMessage() : 'unknown error'}`);
    }
    return statement;
  }

  private async queryAndClose(cypher: string): Promise<void> {
    await closeResults(await this.connection.query(cypher));
  }
}

const runRow = (value: JvmArtifactBatch['runs'][number]) => ({
  ...value, completedAt: value.completedAt ?? null, providerVersion: value.providerVersion ?? null,
});
const artifactRow = (value: JvmArtifactBatch['artifacts'][number]) => ({
  ...value, coordinate: value.coordinate ?? null, binaryJarPath: value.binaryJarPath ?? null,
  headerJarPath: value.headerJarPath ?? null, sourceJarPath: value.sourceJarPath ?? null,
});
const classRow = (value: JvmArtifactBatch['classes'][number]) => ({
  ...value, access: value.access ?? null, superName: value.superName ?? null,
  sourceEntry: value.sourceEntry ?? null,
});
const methodRow = (value: JvmArtifactBatch['methods'][number]) => ({
  ...value, declaration: value.declaration ?? null, access: value.access ?? null,
});
const fieldRow = (value: JvmArtifactBatch['fields'][number]) => ({
  ...value, declaration: value.declaration ?? null, access: value.access ?? null,
});

const WRITE_TRANSACTION_BATCH_SIZE = 1_000;

function* chunks<T>(items: T[]): IterableIterator<T[]> {
  for (let index = 0; index < items.length; index += WRITE_TRANSACTION_BATCH_SIZE) {
    yield items.slice(index, index + WRITE_TRANSACTION_BATCH_SIZE);
  }
}

async function closeResults(result: LbugQueryResultLike | LbugQueryResultLike[]): Promise<void> {
  for (const item of Array.isArray(result) ? result : [result]) await item.close?.();
}
