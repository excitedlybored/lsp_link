import type { LspEntityKind, LspRelation, LspSymbol } from '../model.js';
import type { LspObservationBatch } from '../ingest/batch.js';
import {
  toAnalysisRunRow,
  toBuildRootRow,
  toCallSiteRow,
  toCoverageRow,
  toDiagnosticRow,
  toDocumentRow,
  toHoverRow,
  toOccurrenceRow,
  toParameterRow,
  toRelationRow,
  toSemanticTokenRow,
  toServerRow,
  toSignatureHelpRow,
  toSignatureRow,
  toSymbolRecord,
} from './rows.js';
import { LSP_RELATION_TABLE, LSP_SCHEMA_QUERIES } from './schema.js';
import { JvmArtifactRepository } from '../artifact/repository.js';
import { DerivedCallNormalizationRepository } from '../derived/call-normalization/repository.js';
import { BazelBuildGraphRepository } from '../bazel/repository.js';

export interface LbugQueryResultLike {
  close?(): void | Promise<void>;
  getAll?(): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
}

export interface LbugPreparedStatementLike {
  isSuccess?(): boolean;
  getErrorMessage?(): string | Promise<string>;
}

export interface LbugConnectionLike {
  query(cypher: string): Promise<LbugQueryResultLike | LbugQueryResultLike[]>;
  prepare(cypher: string): Promise<LbugPreparedStatementLike>;
  execute(
    statement: LbugPreparedStatementLike,
    parameters: Record<string, unknown>,
  ): Promise<LbugQueryResultLike | LbugQueryResultLike[]>;
  close?(): void | Promise<void>;
}

export interface LbugDatabaseLike {
  close?(): void | Promise<void>;
}

export interface LadybugModuleLike {
  Database: new (path: string, bufferManagerSize?: number) => LbugDatabaseLike;
  Connection: new (database: LbugDatabaseLike) => LbugConnectionLike;
}

export interface LspDatabaseHandle {
  repository: LspLadybugRepository;
  artifactRepository: JvmArtifactRepository;
  callNormalizationRepository: DerivedCallNormalizationRepository;
  bazelBuildGraphRepository: BazelBuildGraphRepository;
  close(): Promise<void>;
}

/**
 * Opens an isolated Ladybug database. The caller supplies the native module so
 * this schema package remains testable without loading a platform binary.
 */
export function openLspLadybugDatabase(
  databasePath: string,
  ladybug: LadybugModuleLike,
): LspDatabaseHandle {
  const configuredPool = process.env.GITNEXUS_LBUG_BUFFER_POOL_MB;
  const configuredPoolMiB = configuredPool === undefined ? 0 : Number(configuredPool);
  if (configuredPool !== undefined && (!Number.isInteger(configuredPoolMiB) || configuredPoolMiB < 64)) {
    throw new Error(`GITNEXUS_LBUG_BUFFER_POOL_MB must be an integer of at least 64, got ${configuredPool}`);
  }
  const database = new ladybug.Database(databasePath, configuredPoolMiB * 1024 * 1024);
  const connection = new ladybug.Connection(database);
  return {
    repository: new LspLadybugRepository(connection),
    artifactRepository: new JvmArtifactRepository(connection),
    callNormalizationRepository: new DerivedCallNormalizationRepository(connection),
    bazelBuildGraphRepository: new BazelBuildGraphRepository(connection),
    async close(): Promise<void> {
      await connection.close?.();
      await database.close?.();
    },
  };
}

export class LspLadybugRepository {
  constructor(private readonly connection: LbugConnectionLike) {}

  /** Creates the schema. Intended for a new `.gitnexus/lsp-lbug` database. */
  async initializeSchema(): Promise<void> {
    for (const ddl of LSP_SCHEMA_QUERIES) await this.queryAndClose(ddl);
  }

  /**
   * Writes a complete observation batch in dependency-safe transactions.
   * Keeping the whole graph in one transaction makes the Ladybug WAL grow
   * with the repository; bounded commits keep large monorepo imports viable.
   */
  async writeBatch(batch: LspObservationBatch): Promise<void> {
    await this.insertRowsInTransactions('LspAnalysisRun', batch.analysisRuns.map(toAnalysisRunRow));
    await this.insertRowsInTransactions('LspBuildRoot', batch.buildRoots.map(toBuildRootRow));
    await this.insertRowsInTransactions('LspServer', batch.servers.map(toServerRow));
    await this.insertRowsInTransactions('LspDocument', batch.documents.map(toDocumentRow));

    const symbolsByTable = new Map<LspEntityKind, Array<Record<string, unknown>>>();
    for (const symbol of batch.symbols) {
      const record = toSymbolRecord(symbol);
      const rows = symbolsByTable.get(record.table) ?? [];
      rows.push(record.row as unknown as Record<string, unknown>);
      symbolsByTable.set(record.table, rows);
    }
    for (const [table, rows] of symbolsByTable) await this.insertRowsInTransactions(table, rows);

    await this.insertRowsInTransactions('LspCallSite', batch.callSites.map(toCallSiteRow));
    await this.insertRowsInTransactions('LspOccurrence', batch.occurrences.map(toOccurrenceRow));
    await this.insertRowsInTransactions('LspDiagnostic', batch.diagnostics.map(toDiagnosticRow));
    await this.insertRowsInTransactions('LspCoverage', batch.coverage.map(toCoverageRow));
    await this.insertRowsInTransactions('LspHover', batch.hovers.map(toHoverRow));
    await this.insertRowsInTransactions('LspSemanticToken', batch.semanticTokens.map(toSemanticTokenRow));
    await this.insertRowsInTransactions('LspSignatureHelp', batch.signatureHelps.map(toSignatureHelpRow));
    await this.insertRowsInTransactions('LspSignature', batch.signatures.map(toSignatureRow));
    await this.insertRowsInTransactions('LspParameter', batch.parameters.map(toParameterRow));
    await this.insertRelationsInTransactions(batch.relations);
  }

  private async insertRowsInTransactions(table: LspEntityKind, rows: Array<object>): Promise<void> {
    for (const chunk of chunks(rows)) await this.inTransaction(() => this.insertRows(table, chunk));
  }

  private async insertRelationsInTransactions(relations: LspRelation[]): Promise<void> {
    for (const chunk of chunks(relations)) {
      await this.inTransaction(async () => {
        for (const relation of chunk) await this.insertRelation(relation);
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

  private async insertRows(table: LspEntityKind, rows: Array<object>): Promise<void> {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]!);
    const properties = keys.map((key) => `${key}: $${key}`).join(', ');
    const statement = await this.prepare(`CREATE (n:${table} {${properties}})`);
    for (const row of rows) {
      await closeResults(await this.connection.execute(
        statement,
        row as Record<string, unknown>,
      ));
    }
  }

  private async insertRelation(value: LspRelation): Promise<void> {
    const row = toRelationRow(value);
    const keys = Object.keys(row).filter((key) => key !== 'from' && key !== 'to');
    const properties = keys.map((key) => `${key}: $${key}`).join(', ');
    const cypher =
      `MATCH (source:${value.sourceKind} {id: $from}), ` +
      `(target:${value.targetKind} {id: $to}) ` +
      `CREATE (source)-[relation:${LSP_RELATION_TABLE} {${properties}}]->(target)`;
    const statement = await this.prepare(cypher);
    await closeResults(await this.connection.execute(statement, row as unknown as Record<string, unknown>));
  }

  private async prepare(cypher: string): Promise<LbugPreparedStatementLike> {
    const statement = await this.connection.prepare(cypher);
    if (statement.isSuccess && !statement.isSuccess()) {
      const message = statement.getErrorMessage
        ? await statement.getErrorMessage()
        : 'unknown prepare error';
      throw new Error(`LadybugDB prepare failed: ${message}`);
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

async function closeResults(
  result: LbugQueryResultLike | LbugQueryResultLike[],
): Promise<void> {
  for (const item of Array.isArray(result) ? result : [result]) await item.close?.();
}

/** Ensures callers cannot accidentally persist an unvalidated symbol row. */
export function concreteSymbolTable(symbol: LspSymbol): LspEntityKind {
  return toSymbolRecord(symbol).table;
}
