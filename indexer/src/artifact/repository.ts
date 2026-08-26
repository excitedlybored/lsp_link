import type { LbugConnectionLike, LbugPreparedStatementLike, LbugQueryResultLike } from '../lbug/repository.js';
import {
  emptyJvmArtifactBatch,
  type JvmArtifactBatch,
  type JvmArtifactEnrichmentRun,
  type JvmEntityKind,
  type JvmRelation,
} from './model.js';
import { JVM_ARTIFACT_SCHEMA_QUERIES } from './schema.js';

export class JvmArtifactRepository {
  constructor(private readonly connection: LbugConnectionLike) {}

  /** Internal bulk-loader access; keeps the database handle ownership external. */
  connectionForBulkCopy(): LbugConnectionLike { return this.connection; }

  async initializeSchema(): Promise<void> {
    for (const ddl of JVM_ARTIFACT_SCHEMA_QUERIES) await this.queryAndClose(ddl);
  }

  async writeBatch(batch: JvmArtifactBatch): Promise<void> {
    await this.insertRowsInTransactions('JvmArtifactEnrichmentRun', batch.runs.map(runRow));
    await this.insertRowsInTransactions('JvmArtifact', batch.artifacts.map(artifactRow));
    await this.insertRowsInTransactions('JvmClassResolution', batch.resolutions);
    await this.insertRowsInTransactions('JvmBinaryReference', batch.binaryReferences);
    await this.insertRowsInTransactions('JvmClass', batch.classes.map(classRow));
    await this.insertRowsInTransactions('JvmMethod', batch.methods.map(methodRow));
    await this.insertRowsInTransactions('JvmField', batch.fields.map(fieldRow));
    await this.insertRowsInTransactions('JvmCallSite', batch.callSites);
    await this.mergeBinaryReferenceRelations(batch.binaryReferenceRelations);
    await this.mergeResolutionLinks(batch.resolutions, batch.binaryReferences);
    for (const chunk of chunks(batch.relations)) {
      await this.inTransaction(async () => {
        for (const relation of chunk) await this.insertRelation(relation);
      });
    }
    for (const chunk of chunks(batch.bindings)) {
      await this.inTransaction(async () => {
        for (const binding of chunk) await this.insertBinding(binding);
      });
    }
  }

  /** Idempotent bounded write used by resumable ASM streaming enrichment. */
  async mergeBatch(batch: JvmArtifactBatch): Promise<void> {
    await this.mergeRowsInTransactions('JvmArtifactEnrichmentRun', batch.runs.map(runRow), 'id');
    await this.mergeRowsInTransactions('JvmArtifact', batch.artifacts.map(artifactRow), 'id');
    await this.mergeResolutions(batch.resolutions);
    await this.mergeRowsInTransactions('JvmBinaryReference', batch.binaryReferences, 'binaryName');
    await this.mergeRowsInTransactions('JvmClass', batch.classes.map(classRow), 'id');
    await this.mergeRowsInTransactions('JvmMethod', batch.methods.map(methodRow), 'id');
    await this.mergeRowsInTransactions('JvmField', batch.fields.map(fieldRow), 'id');
    await this.mergeRowsInTransactions('JvmCallSite', batch.callSites, 'id');
    await this.mergeBinaryReferenceRelations(batch.binaryReferenceRelations);
    await this.mergeResolutionLinks(batch.resolutions, batch.binaryReferences);
    for (const chunk of chunks(batch.relations)) {
      await this.inTransaction(() => this.mergeRelations(chunk));
    }
    for (const chunk of chunks(batch.bindings)) {
      await this.inTransaction(() => this.mergeBindings(chunk));
    }
  }

  async finalizeAsmRelations(stageId: string): Promise<void> {
    const parameters = { stageId, separator: '\0' };
    const referenceCountResult = await this.connection.query(
      'MATCH ()-[relation:JvmResolvedReference]->() RETURN count(relation) AS count',
    );
    const referenceCountSingle = Array.isArray(referenceCountResult)
      ? referenceCountResult[0] : referenceCountResult;
    const referenceCountRows = await referenceCountSingle?.getAll?.() ?? [];
    await closeResults(referenceCountResult);
    if (Number(referenceCountRows[0]?.count ?? 0) === 0) return;
    await this.executeQuery(
      `MATCH (owner:JvmClass)-[:JvmResolvedReference]->(reference:JvmBinaryReference)`
      + `-[edge:JvmBinaryReferenceRelation]->(site:JvmCallSite) `
      + `WHERE owner.stageId = $stageId AND edge.kind = 'BYTECODE_CALL_TARGET' `
      + `WITH site, owner, 'jvm-method:' + sha256($stageId + $separator + owner.id + $separator `
      + `+ site.targetName + $separator + site.targetDescriptor + $separator) AS targetId `
      + `MERGE (target:JvmMethod {id: targetId}) `
      + `ON CREATE SET target.stageId = $stageId, target.classId = owner.id, `
      + `target.owner = site.targetOwner, target.name = site.targetName, `
      + `target.descriptor = site.targetDescriptor, target.declaration = NULL, `
      + `target.access = NULL, target.hasCode = false, target.isExternalPlaceholder = true, `
      + `target.annotations = [] `
      + `MERGE (owner)-[declaration:JvmRelation {id: 'jvm-relation:' + sha256($stageId + $separator `
      + `+ 'DECLARES_METHOD' + $separator + owner.id + $separator + targetId + $separator + '0' + $separator)}]->(target) `
      + `ON CREATE SET declaration.kind = 'DECLARES_METHOD', declaration.stageId = $stageId, `
      + `declaration.status = 'observed', declaration.ordinal = 0 `
      + `MERGE (site)-[relation:JvmRelation {id: site.id + ':resolves:' + target.id}]->(target) `
      + `SET relation.kind = 'BYTECODE_RESOLVES_TO', relation.stageId = $stageId, `
      + `relation.status = 'resolved', relation.ordinal = 0, site.status = 'resolved'`,
      parameters,
    );
    await this.executeQuery(
      `MATCH (target:JvmClass)-[:JvmResolvedReference]->(reference:JvmBinaryReference)`
      + `-[edge:JvmBinaryReferenceRelation]->(source:JvmClass) `
      + `WHERE target.stageId = $stageId AND edge.kind = 'SUPERCLASS_TARGET' `
      + `MERGE (source)-[relation:JvmRelation {id: source.id + ':super:' + target.id}]->(target) `
      + `SET relation.kind = 'BYTECODE_SUPERCLASS', relation.stageId = $stageId, `
      + `relation.status = 'resolved', relation.ordinal = 0`,
      parameters,
    );
    await this.executeQuery(
      `MATCH (target:JvmClass)-[:JvmResolvedReference]->(reference:JvmBinaryReference)`
      + `-[edge:JvmBinaryReferenceRelation]->(source:JvmClass) `
      + `WHERE target.stageId = $stageId AND edge.kind = 'INTERFACE_TARGET' `
      + `MERGE (source)-[relation:JvmRelation {id: source.id + ':interface:' + target.id}]->(target) `
      + `SET relation.kind = 'BYTECODE_INTERFACE', relation.stageId = $stageId, `
      + `relation.status = 'resolved', relation.ordinal = 0`,
      parameters,
    );
  }

  async resolveClassArtifacts(binaryNames: string[]): Promise<Map<string, string>> {
    if (binaryNames.length === 0) return new Map();
    const statement = await this.prepare(
      `UNWIND $names AS name MATCH (resolution:JvmClassResolution {binaryName: name}) `
      + `RETURN resolution.binaryName AS binaryName, resolution.artifactId AS artifactId`,
    );
    const result = await this.connection.execute(statement, { names: [...new Set(binaryNames)] });
    const single = Array.isArray(result) ? result[0] : result;
    const rows = await single?.getAll?.() ?? [];
    await closeResults(result);
    return new Map(rows.map((row) => [String(row.binaryName), String(row.artifactId)]));
  }

  async finalizeAsmRun(run: JvmArtifactEnrichmentRun): Promise<JvmArtifactEnrichmentRun> {
    const countsResult = await this.connection.query(
      `MATCH (n:JvmArtifact) RETURN sum(n.classCount) AS classes, `
      + `sum(n.methodCount) AS methods, sum(n.fieldCount) AS fields, `
      + `sum(n.callSiteCount) AS callSites, sum(n.errorCount) AS errors`,
    );
    const countsSingle = Array.isArray(countsResult) ? countsResult[0] : countsResult;
    const rows = await countsSingle?.getAll?.() ?? [];
    await closeResults(countsResult);
    run.classCount = Number(rows[0]?.classes ?? 0);
    run.methodCount = Number(rows[0]?.methods ?? 0);
    run.fieldCount = Number(rows[0]?.fields ?? 0);
    run.callSiteCount = Number(rows[0]?.callSites ?? 0);
    run.errorCount = run.classpathErrorCount + Number(rows[0]?.errors ?? 0);
    const batch = emptyJvmArtifactBatch();
    batch.runs.push(run);
    await this.mergeBatch(batch);
    return run;
  }

  private async insertRowsInTransactions(table: JvmEntityKind, rows: Array<object>): Promise<void> {
    for (const chunk of chunks(rows)) await this.inTransaction(() => this.insertRows(table, chunk));
  }

  private async mergeRowsInTransactions<T extends object>(
    table: JvmEntityKind,
    rows: T[],
    primaryKey: string,
  ): Promise<void> {
    for (const chunk of chunks(rows)) {
      await this.inTransaction(async () => {
        if (chunk.length === 0) return;
        const keys = Object.keys(chunk[0]!);
        const statement = await this.prepare(
          `UNWIND $rows AS row MERGE (n:${table} {${primaryKey}: row.${primaryKey}}) SET `
          + keys.filter((key) => key !== primaryKey).map((key) => `n.${key} = row.${key}`).join(', '),
        );
        await closeResults(await this.connection.execute(statement, { rows: chunk }));
      });
    }
  }

  private async mergeResolutions(rows: JvmArtifactBatch['resolutions']): Promise<void> {
    for (const chunk of chunks(rows)) {
      await this.inTransaction(async () => {
        const statement = await this.prepare(
          `UNWIND $rows AS row MERGE (n:JvmClassResolution {binaryName: row.binaryName}) `
          + `ON CREATE SET n.stageId = row.stageId, n.classId = row.classId, n.artifactId = row.artifactId, `
          + `n.classpathOrdinal = row.classpathOrdinal `
          + `ON MATCH SET n.classId = CASE WHEN row.classpathOrdinal < n.classpathOrdinal THEN row.classId ELSE n.classId END, `
          + `n.artifactId = CASE WHEN row.classpathOrdinal < n.classpathOrdinal THEN row.artifactId ELSE n.artifactId END, `
          + `n.classpathOrdinal = CASE WHEN row.classpathOrdinal < n.classpathOrdinal THEN row.classpathOrdinal ELSE n.classpathOrdinal END`,
        );
        await closeResults(await this.connection.execute(statement, { rows: chunk }));
      });
    }
  }

  private async mergeBinaryReferenceRelations(
    values: JvmArtifactBatch['binaryReferenceRelations'],
  ): Promise<void> {
    for (const chunk of chunks(values)) await this.inTransaction(async () => {
      for (const targetKind of ['JvmClass', 'JvmCallSite'] as const) {
        const selected = chunk.filter((value) => value.targetKind === targetKind);
        if (selected.length === 0) continue;
        const statement = await this.prepare(
          `UNWIND $rows AS row `
          + `MATCH (source:JvmBinaryReference {binaryName: row.binaryName}), `
          + `(target:${targetKind} {id: row.targetId}) `
          + `MERGE (source)-[relation:JvmBinaryReferenceRelation {id: row.id}]->(target) `
          + `SET relation.kind = row.kind, relation.stageId = row.stageId, relation.ordinal = row.ordinal`,
        );
        await closeResults(await this.connection.execute(statement, { rows: selected }));
      }
    });
  }

  private async mergeResolutionLinks(
    resolutions: JvmArtifactBatch['resolutions'],
    references: JvmArtifactBatch['binaryReferences'],
  ): Promise<void> {
    const names = [...new Set([...resolutions.map((value) => value.binaryName),
      ...references.map((value) => value.binaryName)])];
    if (names.length === 0) return;
    const selectedStatement = await this.prepare(
      `UNWIND $names AS name MATCH (resolution:JvmClassResolution {binaryName: name}) `
      + `RETURN resolution.binaryName AS binaryName, resolution.classId AS classId, `
      + `resolution.stageId AS stageId`,
    );
    const result = await this.connection.execute(selectedStatement, { names });
    const single = Array.isArray(result) ? result[0] : result;
    const selected = (await single?.getAll?.() ?? []).map((row) => ({
      ...row,
      resolvedReferenceId: `resolved-reference:${String(row.binaryName)}`,
    }));
    await closeResults(result);
    if (selected.length === 0) return;
    await this.inTransaction(async () => {
      const deleteSelected = await this.prepare(
        `UNWIND $rows AS row MATCH (:JvmClass)-[link:JvmResolvedReference]`
        + `->(reference:JvmBinaryReference {binaryName: row.binaryName}) DELETE link`,
      );
      await closeResults(await this.connection.execute(deleteSelected, { rows: selected }));
      const createSelected = await this.prepare(
        `UNWIND $rows AS row MATCH (target:JvmClass {id: row.classId}), `
        + `(reference:JvmBinaryReference {binaryName: row.binaryName}) `
        + `MERGE (target)-[link:JvmResolvedReference {id: row.resolvedReferenceId}]->(reference) `
        + `SET link.stageId = row.stageId`,
      );
      await closeResults(await this.connection.execute(createSelected, { rows: selected }));
    });
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

  private async mergeRelations(values: JvmRelation[]): Promise<void> {
    const groups = groupByEndpoints(values);
    for (const relations of groups.values()) {
      const first = relations[0]!;
      const statement = await this.prepare(
        `UNWIND $rows AS row `
        + `MATCH (source:${first.sourceKind} {id: row.from}), (target:${first.targetKind} {id: row.to}) `
        + `MERGE (source)-[relation:JvmRelation {id: row.id}]->(target) `
        + `SET relation.kind = row.kind, relation.stageId = row.stageId, `
        + `relation.status = row.status, relation.ordinal = row.ordinal`,
      );
      const rows = relations.map((value) => ({
        from: value.sourceId, to: value.targetId, id: value.id, kind: value.kind,
        stageId: value.stageId, status: value.status, ordinal: value.ordinal ?? null,
      }));
      await closeResults(await this.connection.execute(statement, { rows }));
    }
  }

  private async insertBinding(value: JvmArtifactBatch['bindings'][number]): Promise<void> {
    const row = {
      from: value.sourceId, to: value.targetId, id: value.id, kind: value.kind,
      stageId: value.stageId, status: value.status, confidence: value.confidence,
      reason: value.reason,
    };
    const statement = await this.prepare(
      `MATCH (source:${value.sourceKind} {id: $from}), (target:${value.targetKind} {id: $to}) ` +
      'CREATE (source)-[binding:LspJvmBinding {id: $id, kind: $kind, stageId: $stageId, ' +
      'status: $status, confidence: $confidence, reason: $reason}]->(target)',
    );
    await closeResults(await this.connection.execute(statement, row));
  }

  private async mergeBindings(values: JvmArtifactBatch['bindings']): Promise<void> {
    const groups = groupByEndpoints(values);
    for (const bindings of groups.values()) {
      const first = bindings[0]!;
      const statement = await this.prepare(
        `UNWIND $rows AS row `
        + `MATCH (source:${first.sourceKind} {id: row.from}), (target:${first.targetKind} {id: row.to}) `
        + `MERGE (source)-[binding:LspJvmBinding {id: row.id}]->(target) `
        + `SET binding.kind = row.kind, binding.stageId = row.stageId, binding.status = row.status, `
        + `binding.confidence = row.confidence, binding.reason = row.reason`,
      );
      const rows = bindings.map((value) => ({
        from: value.sourceId, to: value.targetId, id: value.id, kind: value.kind,
        stageId: value.stageId, status: value.status, confidence: value.confidence,
        reason: value.reason,
      }));
      await closeResults(await this.connection.execute(statement, { rows }));
    }
  }

  private async executeQuery(cypher: string, parameters: Record<string, unknown>): Promise<void> {
    const statement = await this.prepare(cypher);
    await closeResults(await this.connection.execute(statement, parameters));
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
  completedAt: value.completedAt ?? null,
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

function groupByEndpoints<T extends { sourceKind: string; targetKind: string }>(values: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = `${value.sourceKind}\0${value.targetKind}`;
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

async function closeResults(result: LbugQueryResultLike | LbugQueryResultLike[]): Promise<void> {
  for (const item of Array.isArray(result) ? result : [result]) await item.close?.();
}
