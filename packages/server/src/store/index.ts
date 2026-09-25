import { listGraphPage } from './graph.js';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

import { checkPostgresSchema } from './schema-state.js';
import { safeErrorInfo } from '../lib/logging.js';

import type {
  EntityListSortBy,
  EmailTask,
  Keyword,
  KeywordVector,
  RankingJudgment,
  ListSortDirection,
  Person,
  PersonTag,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
  SystemSettings,
  GraphQuery,
  GraphPage,
  ListQuery,
  PaginatedResult,
} from '@labby/core';
import { SYSTEM_SETTINGS_ID as CORE_SYSTEM_SETTINGS_ID, constraintSelectorIds, normalizeStoredConstraint, validateKeywordVector, validateRankingJudgment, validateScheduleAssignments, validateUnavailability } from '@labby/core';

/** Numeric role stored in the database (smallint). Root (2) is never stored. */
export const UserRole = {
  User: 0,
  Admin: 1,
  Root: 2,
} as const;

export type AuthRole = typeof UserRole[keyof typeof UserRole];

export interface StoredUser {
  id: string;
  username: string;
  email?: string;
  emailVerifiedAt?: number;
  role: AuthRole;
  passwordHash: string;
  disabled: boolean;
  createdAt: number;
}

export interface RefreshTokenRecord {
  tokenId: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
  replacedByTokenId: string | null;
}

export type AuthVerificationPurpose = 'verify-email' | 'reset-password' | 'change-email';

export interface AuthVerificationCodeRecord {
  tokenId: string;
  purpose: AuthVerificationPurpose;
  userId: string | null;
  targetEmail: string;
  pendingEmail: string | null;
  codeHash: string;
  expiresAt: number;
  createdAt: number;
  consumedAt: number | null;
}

export interface DatabaseBackupSnapshot {
  version: 3;
  createdAt: number;
  tables: {
    persons: Array<Record<string, string | number | null>>;
    personTags: Array<Record<string, string | number | null>>;
    keywords: Array<Record<string, string | number | null>>;
    keywordVectors: Array<Record<string, string | number | null>>;
    rankingJudgments: Array<Record<string, string | number | null>>;
    embeddingMigrationArchive: Array<Record<string, string | number | null>>;
    configs: Array<Record<string, string | number | null>>;
    constraints: Array<Record<string, string | number | null>>;
    schedules: Array<Record<string, string | number | null>>;
    unavailabilities: Array<Record<string, string | number | null>>;
    emailTasks: Array<Record<string, string | number | null>>;
    systemSettings: Array<Record<string, string | number | null>>;
    users: Array<Record<string, string | number | null>>;
    refreshTokens: Array<Record<string, string | number | null>>;
    authVerificationCodes: Array<Record<string, string | number | null>>;
  };
}

interface ScheduleForeignKeyBundle {
  persons: Person[];
  personTags: PersonTag[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
}

interface PersonForeignKeyBundle {
  referencedPersonIds: string[];
}

interface KeywordForeignKeyBundle {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
}

interface ScheduleForeignKeyQuery {
  configIds: string[];
}

interface PersonForeignKeyQuery {
  personIds: string[];
}

interface KeywordForeignKeyQuery {
  keywordIds: string[];
}

export type StoreConnectionConfig =
  | {
    dialect: 'pglite';
    dataDir: string;
  }
  | {
    dialect: 'postgres';
    connectionString: string;
    ssl?: boolean;
  };

type DbRow = Record<string, unknown>;
type TableRowValue = string | number | null;
type TableRow = Record<string, TableRowValue>;
type PostgresDrizzleDb = ReturnType<typeof drizzlePostgres>;
type PgliteDrizzleDb = ReturnType<typeof drizzlePglite>;

const SYSTEM_SETTINGS_ID = CORE_SYSTEM_SETTINGS_ID;

type EntityListSort = {
  sortBy: EntityListSortBy;
  sortDirection: ListSortDirection;
};

type SortableEntity = {
  id: string;
  modifiedAt?: number;
  name?: string;
  notes?: string;
};

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

function nowMs(): number {
  return Date.now();
}

function normalizeEntitySort(sort?: Partial<EntityListSort>): EntityListSort {
  const sortBy = sort?.sortBy ?? 'modifiedAt';
  const sortDirection = sort?.sortDirection ?? (sortBy === 'modifiedAt' ? 'desc' : 'asc');
  return { sortBy, sortDirection };
}

function normalizeSortText(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function compareText(left: string | undefined, right: string | undefined, direction: ListSortDirection): number {
  const leftValue = normalizeSortText(left);
  const rightValue = normalizeSortText(right);
  const diff = leftValue.localeCompare(rightValue);
  return direction === 'asc' ? diff : -diff;
}

function compareNumber(left: number | undefined, right: number | undefined, direction: ListSortDirection): number {
  const leftValue = left ?? 0;
  const rightValue = right ?? 0;
  const diff = leftValue - rightValue;
  return direction === 'asc' ? diff : -diff;
}

function compareSortableEntities<T extends SortableEntity>(
  left: T,
  right: T,
  sort?: Partial<EntityListSort>,
): number {
  const resolved = normalizeEntitySort(sort);
  const comparators: Array<(leftItem: T, rightItem: T) => number> = [];

  if (resolved.sortBy === 'modifiedAt') {
    comparators.push((leftItem, rightItem) => compareNumber(leftItem.modifiedAt, rightItem.modifiedAt, resolved.sortDirection));
  }
  if (resolved.sortBy === 'name') {
    comparators.push((leftItem, rightItem) => compareText(leftItem.name, rightItem.name, resolved.sortDirection));
  }
  if (resolved.sortBy === 'notes') {
    comparators.push((leftItem, rightItem) => compareText(leftItem.notes, rightItem.notes, resolved.sortDirection));
  }

  comparators.push(
    (leftItem, rightItem) => compareNumber(leftItem.modifiedAt, rightItem.modifiedAt, 'desc'),
    (leftItem, rightItem) => compareText(leftItem.name, rightItem.name, 'asc'),
    (leftItem, rightItem) => compareText(leftItem.notes, rightItem.notes, 'asc'),
    (leftItem, rightItem) => compareText(leftItem.id, rightItem.id, 'asc'),
  );

  for (const comparator of comparators) {
    const diff = comparator(left, right);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function valueToTableValue(value: unknown): TableRowValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `base64:${Buffer.from(value).toString('base64')}`;
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function extractConstraintPersonIds(constraint: ScheduleConstraint): string[] {
  return uniqueIds(constraintSelectorIds(constraint).personIds);
}

function extractConstraintTagIds(constraint: ScheduleConstraint): string[] {
  return uniqueIds(constraintSelectorIds(constraint).tagIds);
}

function extractSchedulePersonIds(schedule: SchedulePlan): string[] {
  const ids: string[] = [];
  for (const session of schedule.sessions) {
    for (const presentation of session.presentations) {
      ids.push(presentation.presenterId);
      ids.push(...presentation.questionerIds);
    }
  }
  return uniqueIds(ids);
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class LabbyStore {
  private readonly db: PostgresDrizzleDb | PgliteDrizzleDb;
  private readonly pglite: PGlite | null;
  private readonly pgPool: Pool | null;
  private readonly dialect: StoreConnectionConfig['dialect'];
  private readonly ready: Promise<void>;
  private similarityQueue: Promise<unknown> = Promise.resolve();
  private readonly similarityTransaction = new AsyncLocalStorage<{
    connection?: PoolClient;
    db?: Pick<PostgresDrizzleDb, 'execute'>;
  }>();
  private readonly requestMetrics = new AsyncLocalStorage<{ dbQueries: number; dbDurationMs: number }>();

  withRequestMetrics<T>(metrics: { dbQueries: number; dbDurationMs: number }, work: () => Promise<T>): Promise<T> {
    return this.requestMetrics.run(metrics, work);
  }

  private recordQuery(started: number): void {
    const metrics = this.requestMetrics.getStore();
    if (!metrics) return;
    metrics.dbQueries += 1;
    metrics.dbDurationMs += performance.now() - started;
  }

  constructor(config: StoreConnectionConfig) {
    this.dialect = config.dialect;

    if (config.dialect === 'pglite') {
      this.pglite = new PGlite({
        dataDir: config.dataDir,
        extensions: { vector },
      });
      this.pgPool = null;
      this.db = drizzlePglite({ client: this.pglite });
    } else {
      this.pglite = null;
      this.pgPool = new Pool({
        connectionString: config.connectionString,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 8,
        connectionTimeoutMillis: 15000,
        idleTimeoutMillis: 60000,
        allowExitOnIdle: true,
        query_timeout: 20000,
      });
      this.pgPool.on('error', error => console.error(JSON.stringify({ event: 'db_pool_error', ...safeErrorInfo(error), ...this.poolStats() })));
      this.db = drizzlePostgres(this.pgPool);
    }

    this.ready = this.checkSchema();
    void this.ready.catch(() => {});
  }

  withSimilarityLock<T>(work: () => Promise<T>): Promise<T> {
    // Nested store operations reuse the transaction instead of waiting on their own queue.
    if (this.similarityTransaction.getStore()) return work();
    const run = async () => {
      await this.ensureReady();
      if (!this.pgPool) return this.similarityTransaction.run({}, work);
      const connection = await this.pgPool.connect();
      let discard = false;
      try {
        await connection.query('BEGIN');
        await connection.query("SET LOCAL lock_timeout = '5s'");
        await connection.query("SET LOCAL statement_timeout = '15s'");
        await connection.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
        // Transaction pooling pins a backend only between BEGIN and COMMIT.
        // Session locks plus pool-dispatched queries can strand a lock on another backend.
        await connection.query('SELECT pg_advisory_xact_lock(192837466)');
        const result = await this.similarityTransaction.run(
          { connection, db: drizzlePostgres(connection) }, work,
        );
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        try { await connection.query('ROLLBACK'); }
        catch { discard = true; }
        throw error;
      } finally {
        connection.release(discard);
      }
    };
    const next = this.similarityQueue.then(run, run);
    this.similarityQueue = next.catch(() => {});
    return next;
  }

  private async transaction<T>(work: (query: (text: string, params?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
    const connectionInScope = this.similarityTransaction.getStore()?.connection;
    if (connectionInScope) return work((text, params) => connectionInScope.query(text, params));
    if (this.pglite) return this.pglite.transaction(tx => work((text,params) => tx.query(text,params)));
    const connection = await this.pgPool!.connect();
    try {
      await connection.query('BEGIN');
      const result = await work((text,params) => connection.query(text,params));
      await connection.query('COMMIT');
      return result;
    } catch(error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }

  private async queryRows(query: ReturnType<typeof sql>, operation: 'read' | 'write' = 'read'): Promise<DbRow[]> {
    const db = this.similarityTransaction.getStore()?.db ?? this.db;
    const started = performance.now();
    let result: unknown;
    try { result = await db.execute(query as never); }
    finally { this.recordQuery(started); this.logSlowQuery(started, operation); }
    if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows?: unknown }).rows)) {
      return (result as { rows: DbRow[] }).rows;
    }
    return [];
  }

  private async executeCommand(query: ReturnType<typeof sql>): Promise<void> {
    const db = this.similarityTransaction.getStore()?.db ?? this.db;
    const started = performance.now();
    try { await db.execute(query as never); }
    finally { this.recordQuery(started); this.logSlowQuery(started, 'write'); }
  }

  private logSlowQuery(started: number, operation: 'read' | 'write' | 'connect'): void {
    const durationMs = Math.round(performance.now() - started);
    if (durationMs < 250) return;
    console.info(JSON.stringify({ event: 'db_slow', operation, durationMs, ...this.poolStats() }));
  }

  poolStats(): { poolTotal: number; poolIdle: number; poolWaiting: number } {
    return { poolTotal: this.pgPool?.totalCount ?? 0, poolIdle: this.pgPool?.idleCount ?? 0, poolWaiting: this.pgPool?.waitingCount ?? 0 };
  }

  private async checkSchema(): Promise<void> {
    const started = performance.now();
    if (this.pglite) {
      await checkPostgresSchema({ query: async (text, params) => this.pglite!.query(text, params) });
    } else {
      const connecting = performance.now();
      const connection = await this.pgPool!.connect();
      this.logSlowQuery(connecting, 'connect');
      try { await checkPostgresSchema(connection); } finally { connection.release(); }
    }
    this.logSlowQuery(started, 'read');
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private parsePayload<T>(payload: unknown): T {
    return typeof payload === 'string' ? JSON.parse(payload) as T : payload as T;
  }

  private toSqlInList(ids: readonly string[]): string {
    return ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
  }

  private buildJsonArrayOverlapCondition(column: string, ids: readonly string[]): string {
    if (ids.length === 0) return '1=0';
    const inList = this.toSqlInList(ids);
    return `(${column} ?| ARRAY[${inList}]::text[])`;
  }

  private async listPayloadsByIds<T>(tableName: string, idColumn: string, ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const inList = this.toSqlInList(ids);
    const rows = await this.queryRows(sql.raw(`SELECT payload FROM ${tableName} WHERE ${idColumn} IN (${inList})`));
    return rows.map((row) => this.parsePayload<T>(row.payload));
  }

  private async listPayloads<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    const rows = await this.queryRows(query);
    return rows.map((row) => this.parsePayload<T>(row.payload));
  }

  private async getPayload<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
    const rows = await this.queryRows(query);
    const row = rows[0];
    return row ? this.parsePayload<T>(row.payload) : undefined;
  }

  private parseKeywordVectorRow(row: DbRow): KeywordVector {
    const value = this.parsePayload<KeywordVector>(row.payload);
    validateKeywordVector(value);
    return value;
  }

  private async exportTable(tableName: string): Promise<Array<Record<string, string | number | null>>> {
    const rows = await this.queryRows(sql.raw(`SELECT * FROM ${tableName}`));
    return rows.map((row) => {
      const normalized: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(row)) {
        normalized[key] = valueToTableValue(value);
      }
      return normalized;
    });
  }

  private validateTableRows(tableName: string, rows: unknown): TableRow[] {
    if (!Array.isArray(rows)) {
      throw new Error(`Invalid backup payload: table ${tableName} must be an array`);
    }

    return rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Invalid backup payload: table ${tableName} contains a non-object row`);
      }

      const normalized: TableRow = {};
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        if (value === null || typeof value === 'string' || typeof value === 'number') {
          normalized[key] = value;
          continue;
        }
        throw new Error(`Invalid backup payload: table ${tableName} has an unsupported value type`);
      }
      return normalized;
    });
  }

  private async run(sqlText: string): Promise<void> {
    for (const statement of sqlText
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await this.executeCommand(sql.raw(`${statement};`));
    }
  }

  async clearAllEntityData(): Promise<void> {
    await this.ensureReady();
    await this.run(`
      DELETE FROM ranking_judgments;
      DELETE FROM embedding_migration_archive;
      DELETE FROM keyword_vectors;
      DELETE FROM system_settings;
      DELETE FROM email_tasks;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
      DELETE FROM constraints;
      DELETE FROM configs;
      DELETE FROM keywords;
      DELETE FROM person_tags;
      DELETE FROM persons;
    `);
  }

  async getPerson(id: string): Promise<Person | undefined> {
    await this.ensureReady();
    return this.getPayload<Person>(sql`SELECT payload FROM persons WHERE id = ${id}`);
  }

  async listPersons(sort?: Partial<EntityListSort>): Promise<Person[]> {
    await this.ensureReady();
    const persons = await this.listPayloads<Person>(sql`SELECT payload FROM persons`);
    return persons.sort((left, right) => compareSortableEntities(left, right, sort));
  }

  private async listEntityPage<T>(table: 'persons' | 'person_tags' | 'keywords', query: ListQuery): Promise<PaginatedResult<T>> {
    await this.ensureReady();
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit)));
    const direction = query.sortDirection === 'desc' ? 'DESC' : 'ASC';
    const sort = query.sortBy ?? 'modifiedAt';
    const language = query.locale === 'zh-CN' ? 'zh' : query.locale === 'ja-JP' ? 'ja' : 'en';
    const collation = this.pglite ? '"C"' : query.locale === 'zh-CN' ? '"zh-x-icu"' : query.locale === 'ja-JP' ? '"ja-x-icu"' : '"en-x-icu"';
    const localizedName = (alias: string) => `lower(coalesce(nullif(btrim(${alias}.payload->'names'->>'${language}'), ''), nullif(btrim(${alias}.payload->'names'->>'en'), ''), btrim(coalesce(${alias}.payload->>'name', '')))) COLLATE ${collation}`;
    const nameExpr = localizedName('t');
    const notesExpr = `lower(btrim(coalesce(t.payload->>'notes', ''))) COLLATE "C"`;
    const modifiedExpr = `coalesce((t.payload->>'modifiedAt')::bigint, 0)`;
    let primary = `${modifiedExpr} ${query.sortDirection === 'asc' ? 'ASC' : 'DESC'}`;
    let joins = '';
    if (sort === 'name') primary = `${nameExpr} ${direction}`;
    if (sort === 'notes') primary = `${notesExpr} ${direction}`;
    if (sort === 'disabled' && table !== 'person_tags') primary = `coalesce((t.payload->>'disabled')::boolean, false) ${direction}`;
    if (sort === 'tags' && table === 'persons') {
      joins = `LEFT JOIN LATERAL (
        SELECT string_agg(${localizedName('tag')}, '|' ORDER BY ${localizedName('tag')}, tag.id) AS names
        FROM jsonb_array_elements_text(coalesce(t.payload->'tagIds', '[]'::jsonb)) AS member(tag_id)
        JOIN person_tags tag ON tag.id::text = member.tag_id
      ) tag_sort ON true`;
      primary = `tag_sort.names IS NULL ASC, tag_sort.names ${direction}`;
    }
    if (sort === 'keywords' && table === 'persons') {
      joins = `LEFT JOIN LATERAL (
        SELECT string_agg(${localizedName('keyword')}, '|' ORDER BY ${localizedName('keyword')}, keyword.id) AS names
        FROM jsonb_array_elements_text(coalesce(t.payload->'keywordIds', '[]'::jsonb)) AS member(keyword_id)
        JOIN keywords keyword ON keyword.id::text = member.keyword_id
      ) keyword_sort ON true`;
      primary = `keyword_sort.names IS NULL ASC, keyword_sort.names ${direction}`;
    }
    const [rows, totals] = await Promise.all([
      this.queryRows(sql.raw(`SELECT t.payload FROM ${table} t ${joins} ORDER BY ${primary}, ${modifiedExpr} DESC, ${nameExpr} ASC, ${notesExpr} ASC, t.id ASC LIMIT ${limit} OFFSET ${offset}`)),
      this.queryRows(sql.raw(`SELECT count(*)::int AS total FROM ${table}`)),
    ]);
    return {
      items: rows.map(row => this.parsePayload<T>(row.payload)),
      total: Number(totals[0]?.total ?? 0), offset, limit,
    };
  }

  listPersonsPage(query: ListQuery): Promise<PaginatedResult<Person>> { return this.listEntityPage('persons', query); }
  listPersonTagsPage(query: ListQuery): Promise<PaginatedResult<PersonTag>> { return this.listEntityPage('person_tags', query); }
  listKeywordsPage(query: ListQuery): Promise<PaginatedResult<Keyword>> { return this.listEntityPage('keywords', query); }

  async putPerson(person: Person): Promise<void> {
    await this.ensureReady();
    const updated = { ...person, modifiedAt: person.modifiedAt ?? nowMs() };
    const keywordIds = JSON.stringify(uniqueIds(updated.keywordIds ?? []));
    await this.executeCommand(sql`
      INSERT INTO persons (id, updated_at, keyword_ids, payload) VALUES (${updated.id}, ${new Date(updated.modifiedAt)}, ${keywordIds}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        keyword_ids = excluded.keyword_ids,
        payload = excluded.payload
    `);
  }

  async deletePerson(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM persons WHERE id = ${id}`);
  }

  async clearPersons(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM persons`);
  }

  async getPersonTag(id: string): Promise<PersonTag | undefined> {
    await this.ensureReady();
    return this.getPayload<PersonTag>(sql`SELECT payload FROM person_tags WHERE id = ${id}`);
  }

  async listPersonTags(sort?: Partial<EntityListSort>): Promise<PersonTag[]> {
    await this.ensureReady();
    const tags = await this.listPayloads<PersonTag>(sql`SELECT payload FROM person_tags`);
    return tags.sort((left, right) => compareSortableEntities(left, right, sort));
  }

  async putPersonTag(tag: PersonTag): Promise<void> {
    await this.ensureReady();
    const updated = { ...tag, modifiedAt: tag.modifiedAt ?? nowMs() };
    await this.executeCommand(sql`
      INSERT INTO person_tags (id, updated_at, payload)
      VALUES (${updated.id}, ${new Date(updated.modifiedAt)}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload
    `);
  }

  async deletePersonTag(id: string): Promise<void> {
    await this.ensureReady();
    await this.transaction(async query => {
      const referenced = await query('SELECT 1 FROM constraints WHERE tag_ids ? $1 UNION ALL SELECT 1 FROM unavailabilities WHERE tag_ids ? $1 LIMIT 1', [id]) as { rows: unknown[] };
      if (referenced.rows.length) throw new Error('Tag is referenced by a scheduling rule');
      const result = await query('SELECT id,payload FROM persons') as { rows: Array<{ id: string; payload: Person }> };
      const rows = result.rows;
      for (const row of rows) {
        if (!row.payload.tagIds?.includes(id)) continue;
        const payload = { ...row.payload, tagIds: row.payload.tagIds.filter(tagId => tagId !== id), modifiedAt: nowMs() };
        await query('UPDATE persons SET updated_at=$1,payload=$2::jsonb WHERE id=$3', [new Date(payload.modifiedAt), JSON.stringify(payload), row.id]);
      }
      await query('DELETE FROM person_tags WHERE id=$1', [id]);
    });
  }

  async clearPersonTags(): Promise<void> {
    const tags = await this.listPersonTags();
    for (const tag of tags) await this.deletePersonTag(tag.id);
  }

  async getKeyword(id: string): Promise<Keyword | undefined> {
    await this.ensureReady();
    return this.getPayload<Keyword>(sql`SELECT payload FROM keywords WHERE id = ${id}`);
  }

  async listKeywords(sort?: Partial<EntityListSort>): Promise<Keyword[]> {
    await this.ensureReady();
    const keywords = await this.listPayloads<Keyword>(sql`SELECT payload FROM keywords`);
    return keywords.sort((left, right) => compareSortableEntities(left, right, sort));
  }

  async putKeyword(keyword: Keyword): Promise<void> {
    await this.ensureReady();
    const updated = { ...keyword, modifiedAt: keyword.modifiedAt ?? nowMs() };
    await this.executeCommand(sql`
      INSERT INTO keywords (id, updated_at, payload) VALUES (${updated.id}, ${new Date(updated.modifiedAt)}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
  }

  async deleteKeyword(id: string): Promise<void> {
    await this.ensureReady();
    await this.withSimilarityLock(() => this.transaction(async query => {
      await query("DELETE FROM ranking_judgments WHERE payload->>'anchorId'=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'groups') g, jsonb_array_elements_text(g) candidate WHERE candidate=$1)", [id]);
      await query('DELETE FROM keywords WHERE id=$1',[id]);
    }));
  }

  async clearKeywords(): Promise<void> {
    await this.ensureReady();
    await this.withSimilarityLock(() => this.transaction(async query => {
      await query('DELETE FROM ranking_judgments');
      await query('DELETE FROM keywords');
    }));
  }

  async getKeywordVector(keywordId: string): Promise<KeywordVector | undefined> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      SELECT payload
      FROM keyword_vectors
      WHERE keyword_id = ${keywordId}
    `);
    const row = rows[0];
    return row ? this.parseKeywordVectorRow(row) : undefined;
  }

  async getKeywordVectors(keywordIds: string[]): Promise<KeywordVector[]> {
    await this.ensureReady();
    if (keywordIds.length === 0) return [];

    const escapedIds = keywordIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    const rows = await this.queryRows(sql.raw(`
      SELECT payload
      FROM keyword_vectors
      WHERE keyword_id IN (${escapedIds})
    `));
    return rows.map((row) => this.parseKeywordVectorRow(row));
  }

  async listKeywordVectors(): Promise<KeywordVector[]> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      SELECT payload
      FROM keyword_vectors
      ORDER BY updated_at DESC, keyword_id DESC
    `);
    return rows.map((row) => this.parseKeywordVectorRow(row));
  }

  async listGraph(query: GraphQuery = {}): Promise<GraphPage> {
    await this.ensureReady();
    return listGraphPage({
      query: (text, params) => this.pglite
        ? this.pglite.query(text, params)
        : (this.similarityTransaction.getStore()?.connection ?? this.pgPool!).query(text, params),
    }, query);
  }

  async putKeywordVector(vector: KeywordVector): Promise<void> {
    await this.putKeywordVectors([vector]);
  }

  async putKeywordVectors(vectors: KeywordVector[]): Promise<void> {
    await this.ensureReady();
    for (const value of vectors) validateKeywordVector(value);
    await this.writeEmbeddingBatch(vectors);
  }

  private async writeEmbeddingBatch(vectors: KeywordVector[], history?: RankingJudgment[]): Promise<void> {
    const write = async (query: (text: string, params?: unknown[]) => Promise<unknown>) => {
      if (vectors.length) await query(
        `INSERT INTO keyword_vectors(keyword_id,x,y,embedding,geometry,updated_at,payload)
         SELECT (v->>'keywordId')::uuid,(v->>'x')::float8,(v->>'y')::float8,v->'embedding',v->'geometry',to_timestamp((v->>'updatedAt')::double precision/1000),v
         FROM jsonb_array_elements($1::jsonb) AS v
         ON CONFLICT(keyword_id) DO UPDATE SET x=excluded.x,y=excluded.y,embedding=excluded.embedding,
           geometry=excluded.geometry,updated_at=excluded.updated_at,payload=excluded.payload`,
        [JSON.stringify(vectors)]);
      if (history) {
        await query('DELETE FROM ranking_judgments');
        if (history.length) await query("INSERT INTO ranking_judgments(id,payload) SELECT (v->>'id')::uuid,v FROM jsonb_array_elements($1::jsonb) v", [JSON.stringify(history)]);
      }
    };
    await this.transaction(write);
  }


  async forgetRankingJudgment(id: string): Promise<void> {
    await this.withSimilarityLock(() => this.transaction(async query => { await query('DELETE FROM ranking_judgments WHERE id=$1',[id]); }));
  }

  async getRankingHistory(): Promise<RankingJudgment[]> {
    await this.ensureReady();
    return this.listPayloads<RankingJudgment>(sql`SELECT payload FROM ranking_judgments ORDER BY id`);
  }

  async commitRanking(vectors: KeywordVector[], history: RankingJudgment[]): Promise<void> {
    await this.ensureReady();
    const ids = new Set((await this.listKeywords()).map(k => k.id));
    for (const value of vectors) validateKeywordVector(value);
    for (const judgment of history) validateRankingJudgment(judgment, ids);
    await this.writeEmbeddingBatch(vectors, history);
  }

  async deleteKeywordVector(keywordId: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keyword_vectors WHERE keyword_id = ${keywordId}`);
  }

  async clearKeywordVectors(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keyword_vectors`);
  }

  async getConfig(id: string): Promise<ScheduleConfig | undefined> {
    await this.ensureReady();
    return this.getPayload<ScheduleConfig>(sql`SELECT payload FROM configs WHERE id = ${id}`);
  }

  async listConfigs(): Promise<ScheduleConfig[]> {
    await this.ensureReady();
    return this.listPayloads<ScheduleConfig>(sql`SELECT payload FROM configs ORDER BY updated_at DESC, id DESC`);
  }

  async putConfig(config: ScheduleConfig): Promise<void> {
    await this.ensureReady();
    const updated = { ...config, modifiedAt: config.modifiedAt ?? nowMs() };
    await this.executeCommand(sql`
      INSERT INTO configs (id, updated_at, payload) VALUES (${updated.id}, ${new Date(updated.modifiedAt)}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
  }

  async deleteConfig(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM constraints WHERE config_id = ${id}`);
    await this.executeCommand(sql`DELETE FROM configs WHERE id = ${id}`);
  }

  async clearConfigs(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM configs`);
  }

  async getConstraint(id: string): Promise<ScheduleConstraint | undefined> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      SELECT id, config_id, payload
      FROM constraints
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return undefined;
    const payload = this.parsePayload<ScheduleConstraint>(row.payload);
    const configId = String(row.config_id ?? payload.configId ?? '');
    return {
      ...payload,
      id: String(payload.id ?? row.id),
      configId,
    };
  }

  async listConstraints(): Promise<ScheduleConstraint[]> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      SELECT id, config_id, payload
      FROM constraints
      ORDER BY updated_at DESC, id DESC
    `);
    return rows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(row.payload);
      const configId = String(row.config_id ?? payload.configId ?? '');
      return {
        ...payload,
        id: String(payload.id ?? row.id),
        configId,
      };
    });
  }

  async putConstraint(constraint: ScheduleConstraint): Promise<void> {
    await this.ensureReady();
    const updated = {
      ...constraint,
      configId: constraint.configId ?? '',
      modifiedAt: constraint.modifiedAt ?? nowMs(),
    };
    const personIds = JSON.stringify(extractConstraintPersonIds(updated));
    const tagIds = JSON.stringify(extractConstraintTagIds(updated));
    await this.executeCommand(sql`
      INSERT INTO constraints (id, config_id, type, person_ids, tag_ids, payload, created_at, updated_at)
      VALUES (${updated.id}, ${updated.configId || null}, ${updated.type}, ${personIds}, ${tagIds}, ${JSON.stringify(updated)}, ${new Date(updated.modifiedAt)}, ${new Date(updated.modifiedAt)})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        type = excluded.type,
        person_ids = excluded.person_ids,
        tag_ids = excluded.tag_ids,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
  }

  async deleteConstraint(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM constraints WHERE id = ${id}`);
  }

  async clearConstraints(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM constraints`);
  }

  async listConstraintsByConfig(configId: string): Promise<ScheduleConstraint[]> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      SELECT id, config_id, payload
      FROM constraints
      WHERE config_id = ${configId} OR config_id IS NULL
      ORDER BY updated_at DESC, id DESC
    `);
    return rows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(row.payload);
      const rowConfigId = String(row.config_id ?? payload.configId ?? '');
      return {
        ...payload,
        id: String(payload.id ?? row.id),
        configId: rowConfigId,
      };
    });
  }

  async getEmailTask(id: string): Promise<EmailTask | undefined> {
    await this.ensureReady();
    return this.getPayload<EmailTask>(sql`SELECT payload FROM email_tasks WHERE id = ${id}`);
  }

  async listEmailTasks(): Promise<EmailTask[]> {
    await this.ensureReady();
    return this.listPayloads<EmailTask>(sql`SELECT payload FROM email_tasks ORDER BY updated_at DESC, id DESC`);
  }

  async putEmailTask(task: EmailTask): Promise<void> {
    await this.ensureReady();
    const updated = { ...task, modifiedAt: task.modifiedAt ?? nowMs() };
    await this.executeCommand(sql`
      INSERT INTO email_tasks (id, config_id, updated_at, payload)
      VALUES (${updated.id}, ${updated.configId}, ${new Date(updated.modifiedAt)}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
  }

  async deleteEmailTask(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM email_tasks WHERE id = ${id}`);
  }

  async clearEmailTasks(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM email_tasks`);
  }

  /** Atomically claim one provider occurrence across all API replicas. */
  async claimSchedulerDispatch(id: string, jobName: string): Promise<boolean> {
    await this.ensureReady();
    const rows = await this.queryRows(sql`
      INSERT INTO scheduler_dispatches (id, job_name)
      VALUES (${id}, ${jobName})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, 'write');
    return rows.length > 0;
  }

  async finishSchedulerDispatch(id: string, success: boolean): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      UPDATE scheduler_dispatches
      SET status = ${success ? 'succeeded' : 'failed'}, finished_at = now()
      WHERE id = ${id}
    `);
  }

  async pruneSchedulerDispatches(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM scheduler_dispatches WHERE claimed_at < now() - interval '30 days'`);
  }

  async getSystemSettings(): Promise<SystemSettings> {
    await this.ensureReady();
    return await this.getPayload<SystemSettings>(sql`SELECT payload FROM system_settings WHERE id = ${SYSTEM_SETTINGS_ID}`)
      ?? { id: SYSTEM_SETTINGS_ID };
  }

  async putSystemSettings(settings: SystemSettings): Promise<void> {
    await this.ensureReady();
    const updated: SystemSettings = {
      ...settings,
      id: SYSTEM_SETTINGS_ID,
      modifiedAt: settings.modifiedAt ?? nowMs(),
    };
    await this.executeCommand(sql`
      INSERT INTO system_settings (id, updated_at, payload)
      VALUES (${SYSTEM_SETTINGS_ID}, ${new Date(updated.modifiedAt!)}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
  }

  async getSchedule(id: string): Promise<SchedulePlan | undefined> {
    await this.ensureReady();
    return this.getPayload<SchedulePlan>(sql`SELECT payload FROM schedules WHERE id = ${id}`);
  }

  async listSchedules(): Promise<SchedulePlan[]> {
    await this.ensureReady();
    return this.listPayloads<SchedulePlan>(sql`SELECT payload FROM schedules ORDER BY updated_at DESC, created_at DESC, id DESC`);
  }

  async putSchedule(schedule: SchedulePlan): Promise<void> {
    await this.ensureReady();
    const config = await this.getConfig(schedule.configId);
    if (!config) throw new Error('Schedule config not found');
    const [persons, unavailabilities, constraints] = await Promise.all([
      this.listPersons(), this.listUnavailabilities(), this.listConstraintsByConfig(config.id),
    ]);
    const violations = validateScheduleAssignments(schedule.sessions, {
      config, persons, unavailabilities, constraints,
      similarities: { getPairSimilarity: () => undefined },
    });
    if (violations.length) throw new Error(violations[0]);
    const updated = { ...schedule, modifiedAt: schedule.modifiedAt ?? nowMs() };
    const personIds = JSON.stringify(extractSchedulePersonIds(updated));
    await this.executeCommand(sql`
      INSERT INTO schedules (id, config_id, created_at, updated_at, person_ids, payload)
      VALUES (${updated.id}, ${updated.configId}, ${new Date(updated.createdAt)}, ${new Date(updated.modifiedAt)}, ${personIds}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        person_ids = excluded.person_ids,
        payload = excluded.payload
    `);
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM schedules WHERE id = ${id}`);
  }

  async clearSchedules(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM schedules`);
  }

  async getUnavailability(id: string): Promise<PersonUnavailability | undefined> {
    await this.ensureReady();
    return this.getPayload<PersonUnavailability>(sql`SELECT payload FROM unavailabilities WHERE id = ${id}`);
  }

  async listUnavailabilities(): Promise<PersonUnavailability[]> {
    await this.ensureReady();
    return this.listPayloads<PersonUnavailability>(sql`SELECT payload FROM unavailabilities ORDER BY start_date, end_date, id`);
  }

  async putUnavailability(unavailability: PersonUnavailability): Promise<void> {
    await this.ensureReady();
    const errors = validateUnavailability(unavailability);
    if (errors.length) throw new Error(errors[0]);
    const normalized: PersonUnavailability = {
      ...unavailability,
      personIds: unavailability.allPeople ? [] : uniqueIds(unavailability.personIds),
      tagIds: unavailability.allPeople ? [] : uniqueIds(unavailability.tagIds),
    };
    await this.executeCommand(sql`
      INSERT INTO unavailabilities (id, person_ids, tag_ids, all_people, config_id, start_date, end_date, payload)
      VALUES (
        ${normalized.id},
        ${JSON.stringify(normalized.personIds)},
        ${JSON.stringify(normalized.tagIds)},
        ${normalized.allPeople},
        ${normalized.configId},
        ${normalized.startDate},
        ${normalized.endDate},
        ${JSON.stringify(normalized)}
      )
      ON CONFLICT(id) DO UPDATE SET
        person_ids = excluded.person_ids,
        tag_ids = excluded.tag_ids,
        all_people = excluded.all_people,
        config_id = excluded.config_id,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        payload = excluded.payload
    `);
  }

  async listScheduleForeignKeys(query: ScheduleForeignKeyQuery): Promise<ScheduleForeignKeyBundle> {
    await this.ensureReady();
    const configIds = uniqueIds(query.configIds ?? []);
    if (configIds.length === 0) {
      return {
        persons: [],
        personTags: [],
        keywords: [],
        keywordVectors: [],
        configs: [],
        constraints: [],
        schedules: [],
        unavailabilities: [],
      };
    }

    const configs = await this.listPayloadsByIds<ScheduleConfig>('configs', 'id', configIds);
    const configInList = this.toSqlInList(configIds);

    const scheduleRows = await this.queryRows(sql.raw(`
      SELECT payload, person_ids
      FROM schedules
      WHERE config_id IN (${configInList})
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `));
    const schedules = scheduleRows.map((row) => this.parsePayload<SchedulePlan>(row.payload));

    const constraintRows = await this.queryRows(sql.raw(`
      SELECT id, config_id, payload, person_ids, tag_ids
      FROM constraints
      WHERE config_id IN (${configInList}) OR config_id IS NULL
      ORDER BY updated_at DESC, id DESC
    `));
    const constraints = constraintRows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(row.payload);
      return {
        ...payload,
        id: String(payload.id ?? row.id),
        configId: String(row.config_id ?? payload.configId ?? ''),
      };
    });

    const unavailabilityRows = await this.queryRows(sql.raw(`
      SELECT payload, person_ids, tag_ids
      FROM unavailabilities
      WHERE config_id IN (${configInList})
      ORDER BY start_date, end_date, id
    `));
    const unavailabilities = unavailabilityRows.map((row) => this.parsePayload<PersonUnavailability>(row.payload));

    const personIdSet = new Set<string>();
    for (const row of [...scheduleRows, ...constraintRows, ...unavailabilityRows]) {
      // JSONB arrays are already decoded by both PostgreSQL and PGlite.
      if (!Array.isArray(row.person_ids)) throw new Error('Invalid person_ids: expected JSONB array');
      for (const id of row.person_ids) {
        if (typeof id !== 'string') throw new Error('Invalid person ID in foreign-key index');
        personIdSet.add(id);
      }
    }

    const referencedTagIds = uniqueIds([
      ...constraints.flatMap(extractConstraintTagIds),
      ...unavailabilities.flatMap(item => item.tagIds),
    ]);
    const taggedPersons = referencedTagIds.length
      ? await this.listPayloads<Person>(sql.raw(`SELECT payload FROM persons WHERE ${this.buildJsonArrayOverlapCondition("payload->'tagIds'", referencedTagIds)}`))
      : [];
    for (const person of taggedPersons) personIdSet.add(person.id);
    const persons = await this.listPayloadsByIds<Person>('persons', 'id', [...personIdSet]);
    const keywordIdSet = new Set<string>();
    for (const person of persons) {
      for (const keywordId of person.keywordIds ?? []) keywordIdSet.add(keywordId);
    }
    const keywordIds = [...keywordIdSet];
    const tagIds = uniqueIds([...referencedTagIds, ...persons.flatMap(person => person.tagIds ?? [])]);
    const [keywords, keywordVectors, personTags] = await Promise.all([
      this.listPayloadsByIds<Keyword>('keywords', 'id', keywordIds),
      this.getKeywordVectors(keywordIds),
      this.listPayloadsByIds<PersonTag>('person_tags', 'id', tagIds),
    ]);

    return {
      persons,
      personTags,
      keywords,
      keywordVectors,
      configs,
      constraints,
      schedules,
      unavailabilities,
    };
  }

  async listPersonForeignKeys(query: PersonForeignKeyQuery): Promise<PersonForeignKeyBundle> {
    await this.ensureReady();
    const personIds = uniqueIds(query.personIds ?? []);
    if (personIds.length === 0) return { referencedPersonIds: [] };
    const persons = await this.listPayloadsByIds<Person>('persons', 'id', personIds);
    const overlapCondition = this.buildJsonArrayOverlapCondition('person_ids', personIds);
    const personTagIds = uniqueIds(persons.flatMap(person => person.tagIds ?? []));
    const constraintOverlapCondition = personTagIds.length
      ? `(${overlapCondition} OR ${this.buildJsonArrayOverlapCondition('tag_ids', personTagIds)})`
      : overlapCondition;
    const unavailabilityOverlapCondition = personTagIds.length
      ? `(${overlapCondition} OR ${this.buildJsonArrayOverlapCondition('tag_ids', personTagIds)})`
      : overlapCondition;
    const [schedules, constraints, unavailabilities] = await Promise.all([
      this.queryRows(sql.raw(`SELECT person_ids FROM schedules WHERE ${overlapCondition}`)),
      this.queryRows(sql.raw(`SELECT person_ids, tag_ids FROM constraints WHERE ${constraintOverlapCondition}`)),
      this.queryRows(sql.raw(`SELECT person_ids, tag_ids FROM unavailabilities WHERE ${unavailabilityOverlapCondition}`)),
    ]);
    const requested = new Set(personIds);
    const referenced = new Set<string>();
    const include = (ids: unknown) => {
      const list = typeof ids === 'string' ? JSON.parse(ids) as unknown : ids;
      if (Array.isArray(list)) for (const id of list) if (requested.has(String(id))) referenced.add(String(id));
    };
    for (const row of schedules) include(row.person_ids);
    for (const row of unavailabilities) {
      include(row.person_ids);
      const tags = typeof row.tag_ids === 'string' ? JSON.parse(row.tag_ids) as unknown : row.tag_ids;
      if (Array.isArray(tags)) for (const person of persons)
        if (person.tagIds?.some(tagId => tags.includes(tagId))) referenced.add(person.id);
    }
    for (const row of constraints) {
      include(row.person_ids);
      const tags = typeof row.tag_ids === 'string' ? JSON.parse(row.tag_ids) as unknown : row.tag_ids;
      if (Array.isArray(tags)) for (const person of persons)
        if (person.tagIds?.some(tagId => tags.includes(tagId))) referenced.add(person.id);
    }
    return { referencedPersonIds: [...referenced].sort() };
  }

  async listKeywordForeignKeys(query: KeywordForeignKeyQuery): Promise<KeywordForeignKeyBundle> {
    await this.ensureReady();
    const keywordIds = uniqueIds(query.keywordIds ?? []);
    if (keywordIds.length === 0) {
      return {
        persons: [],
        keywords: [],
        keywordVectors: [],
      };
    }
    const [keywords, keywordVectors] = await Promise.all([
      this.listPayloadsByIds<Keyword>('keywords', 'id', keywordIds),
      this.getKeywordVectors(keywordIds),
    ]);

    const overlapCondition = this.buildJsonArrayOverlapCondition('keyword_ids', keywordIds);
    const personRows = await this.queryRows(sql.raw(`
      SELECT payload
      FROM persons
      WHERE ${overlapCondition}
      ORDER BY updated_at DESC, id DESC
    `));
    const persons = personRows.map((row) => this.parsePayload<Person>(row.payload));

    return {
      persons,
      keywords,
      keywordVectors,
    };
  }

  async deleteUnavailability(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM unavailabilities WHERE id = ${id}`);
  }

  async clearUnavailabilities(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM unavailabilities`);
  }

  async getUserById(id: string): Promise<StoredUser | undefined> {
    await this.ensureReady();
    return this.getPayload<StoredUser>(sql`SELECT payload FROM users WHERE id = ${id}`);
  }

  async findUserByIdentity(identity: string): Promise<StoredUser | undefined> {
    await this.ensureReady();
    const normalized = normalizeIdentity(identity);
    return this.getPayload<StoredUser>(
      sql`SELECT payload FROM users WHERE lower(username) = ${normalized} OR lower(coalesce(email, '')) = ${normalized}`,
    );
  }

  async createUser(user: StoredUser): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO users (id, username, email, role, password_hash, disabled, created_at, payload)
      VALUES (
        ${user.id},
        ${user.username},
        ${user.email ?? null},
        ${user.role},
        ${user.passwordHash},
        ${user.disabled ? 1 : 0},
        ${new Date(user.createdAt)},
        ${JSON.stringify(user)}
      )
    `);
  }

  async listUsers(): Promise<StoredUser[]> {
    await this.ensureReady();
    return this.listPayloads<StoredUser>(sql`SELECT payload FROM users ORDER BY created_at`);
  }

  async updateUser(user: StoredUser): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      UPDATE users SET
        username = ${user.username},
        email = ${user.email ?? null},
        role = ${user.role},
        password_hash = ${user.passwordHash},
        disabled = ${user.disabled ? 1 : 0},
        payload = ${JSON.stringify(user)}
      WHERE id = ${user.id}
    `);
  }

  async deleteUser(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM users WHERE id = ${id}`);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO refresh_tokens (token_id, user_id, expires_at, created_at, revoked_at, replaced_by_token_id, payload)
      VALUES (
        ${record.tokenId},
        ${record.userId},
        ${new Date(record.expiresAt)},
        ${new Date(record.createdAt)},
        ${record.revokedAt === null ? null : new Date(record.revokedAt)},
        ${record.replacedByTokenId},
        ${JSON.stringify(record)}
      )
      ON CONFLICT(token_id) DO UPDATE SET
        user_id = excluded.user_id,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        revoked_at = excluded.revoked_at,
        replaced_by_token_id = excluded.replaced_by_token_id,
        payload = excluded.payload
    `);
  }

  async getRefreshToken(tokenId: string): Promise<RefreshTokenRecord | undefined> {
    await this.ensureReady();
    return this.getPayload<RefreshTokenRecord>(sql`SELECT payload FROM refresh_tokens WHERE token_id = ${tokenId}`);
  }

  async revokeRefreshToken(tokenId: string, replacedByTokenId: string | null = null): Promise<void> {
    await this.ensureReady();
    const current = await this.getRefreshToken(tokenId);
    if (!current) return;

    const updated: RefreshTokenRecord = {
      ...current,
      revokedAt: current.revokedAt ?? Date.now(),
      replacedByTokenId,
    };
    await this.saveRefreshToken(updated);
  }

  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    await this.executeCommand(sql`
      UPDATE refresh_tokens
      SET revoked_at = coalesce(revoked_at, ${new Date(now)})
      WHERE user_id = ${userId}
    `);
  }

  async pruneExpiredRefreshTokens(now = Date.now()): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM refresh_tokens WHERE expires_at < ${new Date(now)} OR revoked_at IS NOT NULL`);
  }

  async saveAuthVerificationCode(record: AuthVerificationCodeRecord): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO auth_verification_codes (
        token_id,
        purpose,
        user_id,
        target_email,
        pending_email,
        code_hash,
        expires_at,
        created_at,
        consumed_at,
        payload
      )
      VALUES (
        ${record.tokenId},
        ${record.purpose},
        ${record.userId},
        ${record.targetEmail},
        ${record.pendingEmail},
        ${record.codeHash},
        ${new Date(record.expiresAt)},
        ${new Date(record.createdAt)},
        ${record.consumedAt === null ? null : new Date(record.consumedAt)},
        ${JSON.stringify(record)}
      )
      ON CONFLICT(token_id) DO UPDATE SET
        purpose = excluded.purpose,
        user_id = excluded.user_id,
        target_email = excluded.target_email,
        pending_email = excluded.pending_email,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        consumed_at = excluded.consumed_at,
        payload = excluded.payload
    `);
  }

  async getLatestActiveAuthVerificationCode(input: {
    purpose: AuthVerificationPurpose;
    userId?: string;
    targetEmail?: string;
    now?: number;
  }): Promise<AuthVerificationCodeRecord | undefined> {
    await this.ensureReady();
    const now = input.now ?? Date.now();

    if (input.userId) {
      return this.getPayload<AuthVerificationCodeRecord>(sql`
        SELECT payload
        FROM auth_verification_codes
        WHERE purpose = ${input.purpose}
          AND user_id = ${input.userId}
          AND consumed_at IS NULL
          AND expires_at > ${new Date(now)}
        ORDER BY created_at DESC
        LIMIT 1
      `);
    }

    if (input.targetEmail) {
      return this.getPayload<AuthVerificationCodeRecord>(sql`
        SELECT payload
        FROM auth_verification_codes
        WHERE purpose = ${input.purpose}
          AND lower(target_email) = ${normalizeIdentity(input.targetEmail)}
          AND consumed_at IS NULL
          AND expires_at > ${new Date(now)}
        ORDER BY created_at DESC
        LIMIT 1
      `);
    }

    return undefined;
  }

  async getLatestAuthVerificationCode(input: {
    purpose: AuthVerificationPurpose;
    userId?: string;
    targetEmail?: string;
  }): Promise<AuthVerificationCodeRecord | undefined> {
    await this.ensureReady();

    if (input.userId) {
      return this.getPayload<AuthVerificationCodeRecord>(sql`
        SELECT payload
        FROM auth_verification_codes
        WHERE purpose = ${input.purpose}
          AND user_id = ${input.userId}
        ORDER BY created_at DESC
        LIMIT 1
      `);
    }

    if (input.targetEmail) {
      return this.getPayload<AuthVerificationCodeRecord>(sql`
        SELECT payload
        FROM auth_verification_codes
        WHERE purpose = ${input.purpose}
          AND lower(target_email) = ${normalizeIdentity(input.targetEmail)}
        ORDER BY created_at DESC
        LIMIT 1
      `);
    }

    return undefined;
  }

  async consumeAuthVerificationCode(tokenId: string, consumedAt = Date.now()): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      UPDATE auth_verification_codes
      SET consumed_at = coalesce(consumed_at, ${new Date(consumedAt)})
      WHERE token_id = ${tokenId}
    `);
  }

  async pruneAuthVerificationCodes(input?: {
    now?: number;
    consumedRetentionMs?: number;
    expiredRetentionMs?: number;
  }): Promise<void> {
    await this.ensureReady();
    const now = input?.now ?? Date.now();
    const consumedRetentionMs = input?.consumedRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const expiredRetentionMs = input?.expiredRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const consumedBefore = now - consumedRetentionMs;
    const expiredCreatedBefore = now - expiredRetentionMs;

    await this.executeCommand(sql`
      DELETE FROM auth_verification_codes
      WHERE (consumed_at IS NOT NULL AND consumed_at < ${new Date(consumedBefore)})
         OR (expires_at < ${new Date(now)} AND created_at < ${new Date(expiredCreatedBefore)})
    `);
  }

  async exportBackupSnapshot(): Promise<DatabaseBackupSnapshot> {
    await this.ensureReady();
    return {
      version: 3,
      createdAt: Date.now(),
      tables: {
        persons: await this.exportTable('persons'),
        personTags: await this.exportTable('person_tags'),
        keywords: await this.exportTable('keywords'),
        keywordVectors: await this.exportTable('keyword_vectors'),
        rankingJudgments: await this.exportTable('ranking_judgments'),
        embeddingMigrationArchive: await this.exportTable('embedding_migration_archive'),
        configs: await this.exportTable('configs'),
        constraints: await this.exportTable('constraints'),
        schedules: await this.exportTable('schedules'),
        unavailabilities: await this.exportTable('unavailabilities'),
        emailTasks: await this.exportTable('email_tasks'),
        systemSettings: await this.exportTable('system_settings'),
        users: await this.exportTable('users'),
        refreshTokens: await this.exportTable('refresh_tokens'),
        authVerificationCodes: await this.exportTable('auth_verification_codes'),
      },
    };
  }

  async restoreBackupSnapshot(snapshot: unknown): Promise<void> {
    await this.ensureReady();

    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('Invalid backup payload: expected an object');
    }

    const snapshotObject = snapshot as {
      version?: unknown;
      tables?: Record<string, unknown>;
    };

    if (snapshotObject.version !== 3) {
      throw new Error('Unsupported backup snapshot version');
    }
    if (!snapshotObject.tables || typeof snapshotObject.tables !== 'object' || Array.isArray(snapshotObject.tables)) {
      throw new Error('Invalid backup payload: missing tables');
    }

    const tables = {
      persons: this.validateTableRows('persons', snapshotObject.tables.persons),
      person_tags: this.validateTableRows('person_tags', snapshotObject.tables.personTags ?? []),
      keywords: this.validateTableRows('keywords', snapshotObject.tables.keywords),
      keyword_vectors: this.validateTableRows('keyword_vectors', snapshotObject.tables.keywordVectors),
      ranking_judgments: this.validateTableRows('ranking_judgments', snapshotObject.tables.rankingJudgments),
      embedding_migration_archive: this.validateTableRows('embedding_migration_archive', snapshotObject.tables.embeddingMigrationArchive),
      configs: this.validateTableRows('configs', snapshotObject.tables.configs),
      constraints: this.validateTableRows('constraints', snapshotObject.tables.constraints ?? []),
      schedules: this.validateTableRows('schedules', snapshotObject.tables.schedules),
      unavailabilities: this.validateTableRows('unavailabilities', snapshotObject.tables.unavailabilities),
      email_tasks: this.validateTableRows('email_tasks', snapshotObject.tables.emailTasks),
      system_settings: this.validateTableRows('system_settings', snapshotObject.tables.systemSettings),
      users: this.validateTableRows('users', snapshotObject.tables.users),
      refresh_tokens: this.validateTableRows('refresh_tokens', snapshotObject.tables.refreshTokens),
      auth_verification_codes: this.validateTableRows(
        'auth_verification_codes',
        snapshotObject.tables.authVerificationCodes ?? [],
      ),
    };

    // Backup payloads are data, not schema history; normalize older records on import.
    for (const row of tables.person_tags) {
      const tag = this.parsePayload<PersonTag>(row.payload);
      if (!tag.names) row.payload = JSON.stringify({ ...tag, names: { en: tag.name, zh: '', ja: '' } });
    }
    for (const row of tables.constraints) {
      const constraint = normalizeStoredConstraint(this.parsePayload<ScheduleConstraint>(row.payload));
      row.payload = JSON.stringify({ ...constraint, disabled: constraint.disabled ?? false });
      row.person_ids = JSON.stringify(extractConstraintPersonIds(constraint));
      row.tag_ids = JSON.stringify(extractConstraintTagIds(constraint));
    }
    for (const row of tables.unavailabilities) {
      const legacy = this.parsePayload<Record<string, unknown>>(row.payload);
      const personIds = Array.isArray(legacy.personIds) ? legacy.personIds
        : typeof legacy.personId === 'string' ? [legacy.personId] : [];
      const { personId: _discarded, ...rest } = legacy;
      row.person_ids = JSON.stringify(personIds);
      row.tag_ids = JSON.stringify(Array.isArray(legacy.tagIds) ? legacy.tagIds : []);
      row.all_people = legacy.allPeople === true ? 'true' : 'false';
      delete row.person_id;
      row.payload = JSON.stringify({ ...rest, personIds, tagIds: JSON.parse(String(row.tag_ids)), allPeople: legacy.allPeople === true });
    }

    const keywordIds = new Set(tables.keywords.map(row => String(row.id)));
    for (const row of tables.keyword_vectors) {
      const value = this.parsePayload<KeywordVector>(row.payload);
      validateKeywordVector(value);
      if (!keywordIds.has(value.keywordId) || row.keyword_id !== value.keywordId) throw new Error('Invalid backup embedding keyword');
    }
    const judgments = tables.ranking_judgments.map(row => this.parsePayload<RankingJudgment>(row.payload));
    for (const j of judgments) validateRankingJudgment(j, keywordIds);
    const restore = async (query: (text: string, params?: unknown[]) => Promise<unknown>) => {
      for (const name of ['refresh_tokens','auth_verification_codes','users','ranking_judgments','embedding_migration_archive','keyword_vectors','system_settings','email_tasks','unavailabilities','schedules','constraints','configs','keywords','person_tags','persons']) await query('DELETE FROM '+name);
      for (const [name, rows] of Object.entries(tables)) {
        for (const row of rows) {
          const columns = Object.keys(row);
          if (!columns.length || columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('Invalid backup column');
          await query('INSERT INTO '+name+' ('+columns.map(c => '"'+c+'"').join(',')+') VALUES ('+columns.map((_,i) => '$'+(i+1)).join(',')+')', columns.map(c => row[c] ?? null));
        }
      }
    };
    await this.withSimilarityLock(() => this.transaction(restore));
  }

  getDialect(): StoreConnectionConfig['dialect'] {
    return this.dialect;
  }

  async close(): Promise<void> {
    await this.ready.catch(() => {});
    await this.pglite?.close();
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}
