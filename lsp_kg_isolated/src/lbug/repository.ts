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

export interface LbugQueryResultLike {
  close?(): void | Promise<void>;
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
  Database: new (path: string) => LbugDatabaseLike;
  Connection: new (database: LbugDatabaseLike) => LbugConnectionLike;
}

export interface LspDatabaseHandle {
  repository: LspLadybugRepository;
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
  const database = new ladybug.Database(databasePath);
  const connection = new ladybug.Connection(database);
  return {
    repository: new LspLadybugRepository(connection),
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

  /** Writes a complete observation batch atomically. */
  async writeBatch(batch: LspObservationBatch): Promise<void> {
    await this.queryAndClose('BEGIN TRANSACTION');
    try {
      await this.insertRows('LspAnalysisRun', batch.analysisRuns.map(toAnalysisRunRow));
      await this.insertRows('LspBuildRoot', batch.buildRoots.map(toBuildRootRow));
      await this.insertRows('LspServer', batch.servers.map(toServerRow));
      await this.insertRows('LspDocument', batch.documents.map(toDocumentRow));

      const symbolsByTable = new Map<LspEntityKind, Array<Record<string, unknown>>>();
      for (const symbol of batch.symbols) {
        const record = toSymbolRecord(symbol);
        const rows = symbolsByTable.get(record.table) ?? [];
        rows.push(record.row as unknown as Record<string, unknown>);
        symbolsByTable.set(record.table, rows);
      }
      for (const [table, rows] of symbolsByTable) await this.insertRows(table, rows);

      await this.insertRows('LspCallSite', batch.callSites.map(toCallSiteRow));
      await this.insertRows('LspOccurrence', batch.occurrences.map(toOccurrenceRow));
      await this.insertRows('LspDiagnostic', batch.diagnostics.map(toDiagnosticRow));
      await this.insertRows('LspCoverage', batch.coverage.map(toCoverageRow));
      await this.insertRows('LspHover', batch.hovers.map(toHoverRow));
      await this.insertRows('LspSemanticToken', batch.semanticTokens.map(toSemanticTokenRow));
      await this.insertRows('LspSignatureHelp', batch.signatureHelps.map(toSignatureHelpRow));
      await this.insertRows('LspSignature', batch.signatures.map(toSignatureRow));
      await this.insertRows('LspParameter', batch.parameters.map(toParameterRow));

      for (const relation of batch.relations) await this.insertRelation(relation);
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

async function closeResults(
  result: LbugQueryResultLike | LbugQueryResultLike[],
): Promise<void> {
  for (const item of Array.isArray(result) ? result : [result]) await item.close?.();
}

/** Ensures callers cannot accidentally persist an unvalidated symbol row. */
export function concreteSymbolTable(symbol: LspSymbol): LspEntityKind {
  return toSymbolRecord(symbol).table;
}
