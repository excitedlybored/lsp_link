import type {
  LbugConnectionLike, LbugPreparedStatementLike, LbugQueryResultLike,
} from '../lbug/repository.js';
import type { RepositoryInventoryBatch } from './model.js';
import { REPOSITORY_INVENTORY_SCHEMA_QUERIES } from './schema.js';

export class RepositoryInventoryRepository {
  constructor(private readonly connection: LbugConnectionLike) {}

  async initializeSchema(): Promise<void> {
    for (const ddl of REPOSITORY_INVENTORY_SCHEMA_QUERIES) await this.queryAndClose(ddl);
  }

  async writeBatch(batch: RepositoryInventoryBatch): Promise<void> {
    await this.insertRows('RepositoryInventoryRun', batch.runs);
    await this.insertRows('RepositoryProviderRun', batch.providers);
    await this.insertRows('RepositoryDocument', batch.documents);
    await this.insertRows('RepositoryDeclaration', batch.declarations);
    await this.insertRelations(
      'RepositoryInventoryRun', 'RepositoryProviderRun',
      batch.providers.map((value) => ({ from: value.runId, to: value.id, kind: 'USED_PROVIDER' })),
    );
    const providerRuns = new Map(batch.providers.map((value) => [value.providerId, value.id]));
    await this.insertRelations(
      'RepositoryProviderRun', 'RepositoryDocument',
      batch.documents.map((value) => ({
        from: providerRuns.get(value.providerId)!, to: value.id, kind: 'INDEXED_DOCUMENT',
      })),
    );
    await this.insertRelations(
      'RepositoryInventoryRun', 'RepositoryDocument',
      batch.documents.map((value) => ({ from: value.runId, to: value.id, kind: 'CONTAINS_DOCUMENT' })),
    );
    await this.insertRelations(
      'RepositoryDocument', 'RepositoryDeclaration',
      batch.declarations.map((value) => ({ from: value.documentId, to: value.id, kind: 'DECLARES' })),
    );
  }

  private async insertRows(table: string, rows: object[]): Promise<void> {
    for (const chunk of chunks(rows)) {
      await this.inTransaction(async () => {
        const keys = Object.keys(chunk[0]!);
        const statement = await this.prepare(
          `CREATE (node:${table} {${keys.map((key) => `${key}: $${key}`).join(', ')}})`,
        );
        for (const row of chunk) await closeResults(await this.connection.execute(
          statement, row as Record<string, unknown>,
        ));
      });
    }
  }

  private async insertRelations(
    sourceKind: string, targetKind: string,
    rows: Array<{ from: string; to: string; kind: string }>,
  ): Promise<void> {
    for (const chunk of chunks(rows)) {
      await this.inTransaction(async () => {
        const statement = await this.prepare(
          `MATCH (source:${sourceKind} {id: $from}), (target:${targetKind} {id: $to}) `
          + 'CREATE (source)-[relation:RepositoryInventoryRelation {kind: $kind}]->(target)',
        );
        for (const row of chunk) await closeResults(await this.connection.execute(statement, row));
      });
    }
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

  private async prepare(cypher: string): Promise<LbugPreparedStatementLike> {
    const statement = await this.connection.prepare(cypher);
    if (statement.isSuccess && !statement.isSuccess()) {
      throw new Error(`LadybugDB prepare failed: ${statement.getErrorMessage
        ? await statement.getErrorMessage() : 'unknown error'}`);
    }
    return statement;
  }

  private async queryAndClose(cypher: string): Promise<void> {
    await closeResults(await this.connection.query(cypher));
  }
}

const WRITE_TRANSACTION_BATCH_SIZE = 1_000;

function* chunks<T>(items: T[]): IterableIterator<T[]> {
  for (let index = 0; index < items.length; index += WRITE_TRANSACTION_BATCH_SIZE) {
    yield items.slice(index, index + WRITE_TRANSACTION_BATCH_SIZE);
  }
}

async function closeResults(result: LbugQueryResultLike | LbugQueryResultLike[]): Promise<void> {
  for (const item of Array.isArray(result) ? result : [result]) await item.close?.();
}
