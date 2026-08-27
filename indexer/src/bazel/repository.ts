import type {
  LbugConnectionLike, LbugPreparedStatementLike, LbugQueryResultLike,
} from '../lbug/repository.js';
import type { BazelBuildGraphBatch, BazelRelation } from './model.js';
import { BAZEL_BUILD_GRAPH_SCHEMA_QUERIES } from './schema.js';

export class BazelBuildGraphRepository {
  constructor(private readonly connection: LbugConnectionLike) {}

  async initializeSchema(): Promise<void> {
    for (const ddl of BAZEL_BUILD_GRAPH_SCHEMA_QUERIES) await this.queryAndClose(ddl);
  }

  async writeBatch(batch: BazelBuildGraphBatch): Promise<void> {
    await this.insertRows('BazelBuildGraphRun', batch.runs.map((value) => ({
      ...value, configurationHash: value.configurationHash ?? null,
      scopeConfigHash: value.scopeConfigHash ?? null,
      scopeSelectorsJson: value.scopeSelectorsJson ?? null,
    })));
    await this.insertRows('BazelTarget', batch.targets.map((value) => ({
      ...value, ruleKind: value.ruleKind ?? null,
    })));
    await this.insertRows('BazelSource', batch.sources);
    await this.insertRows('BazelArtifact', batch.artifacts);
    for (const chunk of chunks(batch.relations)) {
      await this.inTransaction(async () => {
        for (const relation of chunk) await this.insertRelation(relation);
      });
    }
  }

  private async insertRows(table: string, rows: object[]): Promise<void> {
    for (const chunk of chunks(rows)) {
      await this.inTransaction(async () => {
        if (chunk.length === 0) return;
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

  private async insertRelation(value: BazelRelation): Promise<void> {
    const row = {
      from: value.sourceId, to: value.targetId, id: value.id, graphId: value.graphId,
      kind: value.kind, attribute: value.attribute ?? null, ordinal: value.ordinal,
    };
    const statement = await this.prepare(
      `MATCH (source:${value.sourceKind} {id: $from}), `
      + `(target:${value.targetKind} {id: $to}) `
      + 'CREATE (source)-[relation:BazelRelation {id: $id, graphId: $graphId, '
      + 'kind: $kind, attribute: $attribute, ordinal: $ordinal}]->(target)',
    );
    await closeResults(await this.connection.execute(statement, row));
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
