import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { migratePostgres } from './migrate/postgres.js';
import { migrateSqlite } from './migrate/sqlite.js';

import type {
  EntityListSortBy,
  EmailTask,
  Keyword,
  KeywordVector,
  ListSortDirection,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
} from '@labby/core';

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
  version: 1;
  createdAt: number;
  tables: {
    persons: Array<Record<string, string | number | null>>;
    keywords: Array<Record<string, string | number | null>>;
    keywordVectors: Array<Record<string, string | number | null>>;
    configs: Array<Record<string, string | number | null>>;
    constraints: Array<Record<string, string | number | null>>;
    schedules: Array<Record<string, string | number | null>>;
    unavailabilities: Array<Record<string, string | number | null>>;
    emailTasks: Array<Record<string, string | number | null>>;
    users: Array<Record<string, string | number | null>>;
    refreshTokens: Array<Record<string, string | number | null>>;
    authVerificationCodes: Array<Record<string, string | number | null>>;
  };
}

interface ScheduleForeignKeyBundle {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
}

interface PersonForeignKeyBundle {
  keywords: Keyword[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
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
    dialect: 'sqlite';
    path: string;
  }
  | {
    dialect: 'postgres';
    connectionString: string;
    ssl?: boolean;
  };

type DbRow = Record<string, unknown>;
type TableRowValue = string | number | null;
type TableRow = Record<string, TableRowValue>;
type SqliteDrizzleDb = ReturnType<typeof drizzleSqlite>;
type PostgresDrizzleDb = ReturnType<typeof drizzlePostgres>;

const LATENT_DIM = 64;
const PROJECTION_DIM = 2;

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

function toSqlitePath(input: string): string {
  return input;
}

function floatArrayToBuffer(values: readonly number[], expectedLength: number): Buffer {
  const out = Buffer.allocUnsafe(expectedLength * 4);
  for (let i = 0; i < expectedLength; i++) {
    out.writeFloatLE(values[i] ?? 0, i * 4);
  }
  return out;
}

function bufferToFloatArray(value: unknown, expectedLength: number): number[] {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.alloc(0);
  const out = new Array<number>(expectedLength).fill(0);
  for (let i = 0; i < expectedLength && (i + 1) * 4 <= buffer.length; i++) {
    out[i] = buffer.readFloatLE(i * 4);
  }
  return out;
}

function toPgVectorLiteral(values: readonly number[], expectedLength: number): string {
  const normalized = new Array<number>(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const v = values[i] ?? 0;
    normalized[i] = Number.isFinite(v) ? v : 0;
  }
  return `[${normalized.join(',')}]`;
}

function fromPgVectorLiteral(value: unknown, expectedLength: number): number[] {
  if (typeof value !== 'string') return new Array<number>(expectedLength).fill(0);
  const trimmed = value.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!inner) return new Array<number>(expectedLength).fill(0);
  const values = inner.split(',').map((part) => Number.parseFloat(part.trim()));
  const out = new Array<number>(expectedLength).fill(0);
  for (let i = 0; i < expectedLength && i < values.length; i++) {
    out[i] = Number.isFinite(values[i]) ? values[i] : 0;
  }
  return out;
}

function valueToTableValue(value: unknown): TableRowValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
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
  const value = constraint as { personIds?: unknown };
  if (!Array.isArray(value.personIds)) return [];
  return uniqueIds(value.personIds.filter((item): item is string => typeof item === 'string'));
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

function normalizeUnavailabilityPersonIds(unavailability: PersonUnavailability): string[] {
  const withMultiple = unavailability as PersonUnavailability & { personIds?: string[] };
  if (Array.isArray(withMultiple.personIds) && withMultiple.personIds.length > 0) {
    return uniqueIds(withMultiple.personIds);
  }
  if (unavailability.personId) {
    return [unavailability.personId];
  }
  return [];
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class SqliteStore {
  private readonly sqliteDb: SqliteDrizzleDb | null;
  private readonly pgDb: PostgresDrizzleDb | null;
  private readonly sqliteRaw: Database.Database | null;
  private readonly pgPool: Pool | null;
  private readonly dialect: StoreConnectionConfig['dialect'];
  private readonly ready: Promise<void>;
  private sqliteVecEnabled = false;

  constructor(configOrPath: StoreConnectionConfig | string) {
    const config: StoreConnectionConfig = typeof configOrPath === 'string'
      ? { dialect: 'sqlite', path: configOrPath }
      : configOrPath;

    this.dialect = config.dialect;

    if (config.dialect === 'sqlite') {
      const sqlite = new Database(toSqlitePath(config.path));
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      this.sqliteRaw = sqlite;
      this.pgPool = null;
      this.sqliteDb = drizzleSqlite(sqlite);
      this.pgDb = null;
    } else {
      this.sqliteRaw = null;
      this.pgPool = new Pool({
        connectionString: config.connectionString,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      });
      this.sqliteDb = null;
      this.pgDb = drizzlePostgres(this.pgPool);
    }

    this.ready = this.migrate();
  }

  private async queryRows(query: ReturnType<typeof sql>): Promise<DbRow[]> {
    if (this.sqliteDb) {
      return this.sqliteDb.all(query as never) as DbRow[];
    }

    if (!this.pgDb) {
      return [];
    }

    const result = await this.pgDb.execute(query as never);
    if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows?: unknown }).rows)) {
      return (result as { rows: DbRow[] }).rows;
    }
    return [];
  }

  private async executeCommand(query: ReturnType<typeof sql>): Promise<void> {
    if (this.sqliteDb) {
      this.sqliteDb.run(query as never);
      return;
    }

    if (this.pgDb) {
      await this.pgDb.execute(query as never);
    }
  }

  private async migrate(): Promise<void> {
    if (this.sqliteRaw) {
      const migrationResult = migrateSqlite(this.sqliteRaw);
      this.sqliteVecEnabled = migrationResult.sqliteVecEnabled;
      await this.backfillForeignKeyColumns();
      return;
    }

    await migratePostgres(this.executeCommand.bind(this));
    await this.backfillForeignKeyColumns();
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private parsePayload<T>(payload: string): T {
    return JSON.parse(payload) as T;
  }

  private toSqlInList(ids: readonly string[]): string {
    return ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
  }

  private buildJsonArrayOverlapCondition(column: string, ids: readonly string[]): string {
    if (ids.length === 0) return '1=0';
    const inList = this.toSqlInList(ids);
    if (this.sqliteRaw) {
      return `EXISTS (SELECT 1 FROM json_each(${column}) je WHERE je.value IN (${inList}))`;
    }
    return `(${column}::jsonb ?| ARRAY[${inList}]::text[])`;
  }

  private async listPayloadsByIds<T>(tableName: string, idColumn: string, ids: readonly string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const inList = this.toSqlInList(ids);
    const rows = await this.queryRows(sql.raw(`SELECT payload FROM ${tableName} WHERE ${idColumn} IN (${inList})`));
    return rows.map((row) => this.parsePayload<T>(String(row.payload)));
  }

  private async backfillForeignKeyColumns(): Promise<void> {
    const personRows = await this.queryRows(sql`SELECT id, payload FROM persons`);
    for (const row of personRows) {
      const person = this.parsePayload<Person>(String(row.payload));
      const keywordIds = JSON.stringify(uniqueIds(person.keywordIds ?? []));
      await this.executeCommand(sql`UPDATE persons SET keyword_ids = ${keywordIds} WHERE id = ${String(row.id)}`);
    }

    const constraintRows = await this.queryRows(sql`SELECT id, payload FROM constraints`);
    for (const row of constraintRows) {
      const constraint = this.parsePayload<ScheduleConstraint>(String(row.payload));
      const personIds = JSON.stringify(extractConstraintPersonIds(constraint));
      await this.executeCommand(sql`UPDATE constraints SET person_ids = ${personIds} WHERE id = ${String(row.id)}`);
    }

    const scheduleRows = await this.queryRows(sql`SELECT id, payload FROM schedules`);
    for (const row of scheduleRows) {
      const schedule = this.parsePayload<SchedulePlan>(String(row.payload));
      const personIds = JSON.stringify(extractSchedulePersonIds(schedule));
      await this.executeCommand(sql`UPDATE schedules SET person_ids = ${personIds} WHERE id = ${String(row.id)}`);
    }

    const unavailabilityRows = await this.queryRows(sql`SELECT id, payload FROM unavailabilities`);
    for (const row of unavailabilityRows) {
      const unavailability = this.parsePayload<PersonUnavailability>(String(row.payload));
      const personIds = normalizeUnavailabilityPersonIds(unavailability);
      await this.executeCommand(sql`
        UPDATE unavailabilities
        SET person_id = ${personIds[0] ?? ''}, person_ids = ${JSON.stringify(personIds)}
        WHERE id = ${String(row.id)}
      `);
    }
  }

  private async listPayloads<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    const rows = await this.queryRows(query);
    return rows.map((row) => this.parsePayload<T>(String(row.payload)));
  }

  private async getPayload<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
    const rows = await this.queryRows(query);
    const row = rows[0];
    return row ? this.parsePayload<T>(String(row.payload)) : undefined;
  }

  private parseKeywordVectorRow(row: DbRow): KeywordVector {
    const keywordId = String(row.keyword_id ?? row.keywordId ?? '');
    const updatedAt = Number(row.updated_at ?? row.updatedAt ?? Date.now());

    if (this.dialect === 'sqlite') {
      const vector64 = bufferToFloatArray(row.vector_f32, LATENT_DIM);
      const projection = bufferToFloatArray(row.projection_f32, PROJECTION_DIM);
      return {
        keywordId,
        vector64,
        x: Number(row.x ?? projection[0] ?? 0),
        y: Number(row.y ?? projection[1] ?? 0),
        updatedAt,
      };
    }

    const vector64 = fromPgVectorLiteral(row.vector64, LATENT_DIM);
    const projection = fromPgVectorLiteral(row.projection2d, PROJECTION_DIM);
    return {
      keywordId,
      vector64,
      x: Number(row.x ?? projection[0] ?? 0),
      y: Number(row.y ?? projection[1] ?? 0),
      updatedAt,
    };
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

  private normalizeKeywordVectorBackupRows(rows: TableRow[]): TableRow[] {
    return rows.map((row) => {
      const parsedPayload = this.parseKeywordVectorPayload(row.payload);
      const keywordId = String(row.keyword_id ?? parsedPayload?.keywordId ?? '');
      if (!keywordId) {
        throw new Error('Invalid backup payload: keyword_vectors row missing keyword_id');
      }

      const updatedAt = Number(row.updated_at ?? parsedPayload?.updatedAt ?? nowMs());
      const x = Number(row.x ?? parsedPayload?.x ?? 0);
      const y = Number(row.y ?? parsedPayload?.y ?? 0);
      const vector64 = this.resolveKeywordVector64(row, parsedPayload);
      const payload = this.resolveKeywordVectorPayload(row.payload, {
        keywordId,
        vector64,
        x,
        y,
        updatedAt,
      });

      if (this.dialect === 'sqlite') {
        const sqliteRow: TableRow = {
          keyword_id: keywordId,
          x,
          y,
          vector_f32: `base64:${floatArrayToBuffer(vector64, LATENT_DIM).toString('base64')}`,
          projection_f32: `base64:${floatArrayToBuffer([x, y], PROJECTION_DIM).toString('base64')}`,
          updated_at: updatedAt,
          payload,
        };
        return sqliteRow;
      }

      const pgRow: TableRow = {
        keyword_id: keywordId,
        x,
        y,
        vector64: toPgVectorLiteral(vector64, LATENT_DIM),
        projection2d: toPgVectorLiteral([x, y], PROJECTION_DIM),
        updated_at: updatedAt,
        payload,
      };
      return pgRow;
    });
  }

  private parseKeywordVectorPayload(payload: TableRowValue): Partial<KeywordVector> | null {
    if (typeof payload !== 'string') return null;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Partial<KeywordVector>;
    } catch {
      return null;
    }
  }

  private resolveKeywordVector64(row: TableRow, payload: Partial<KeywordVector> | null): number[] {
    if (payload?.vector64 && Array.isArray(payload.vector64)) {
      const out = new Array<number>(LATENT_DIM).fill(0);
      for (let i = 0; i < LATENT_DIM; i++) {
        const value = payload.vector64[i];
        out[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      }
      return out;
    }

    if (typeof row.vector64 === 'string') {
      return fromPgVectorLiteral(row.vector64, LATENT_DIM);
    }

    if (typeof row.vector_f32 === 'string' && row.vector_f32.startsWith('base64:')) {
      const encoded = row.vector_f32.slice('base64:'.length);
      return bufferToFloatArray(Buffer.from(encoded, 'base64'), LATENT_DIM);
    }

    return new Array<number>(LATENT_DIM).fill(0);
  }

  private resolveKeywordVectorPayload(
    payload: TableRowValue,
    fallback: KeywordVector,
  ): string {
    if (typeof payload === 'string') {
      return payload;
    }
    return JSON.stringify(fallback);
  }

  private async restoreTableRows(tableName: string, rows: TableRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      throw new Error(`Invalid backup payload: table ${tableName} row has no columns`);
    }

    for (const row of rows) {
      const values = columns.map((column) => row[column] ?? null);
      const statement = sql.raw(`INSERT INTO ${tableName} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${values.map((value) => this.toSqlValue(value)).join(', ')})`);
      await this.executeCommand(statement);
    }
  }

  private toSqlValue(value: TableRowValue): string {
    if (value === null) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (value.startsWith('base64:')) {
      const encoded = value.slice('base64:'.length).replace(/'/g, "''");
      return this.dialect === 'sqlite'
        ? `X'${Buffer.from(encoded, 'base64').toString('hex')}'`
        : `decode('${encoded}', 'base64')`;
    }
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  private async run(sqlText: string): Promise<void> {
    if (this.sqliteRaw) {
      this.sqliteRaw.exec(sqlText);
      return;
    }

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
      DELETE FROM keyword_vectors;
      DELETE FROM email_tasks;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
      DELETE FROM constraints;
      DELETE FROM configs;
      DELETE FROM keywords;
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

  async putPerson(person: Person): Promise<void> {
    await this.ensureReady();
    const updated = { ...person, modifiedAt: person.modifiedAt ?? nowMs() };
    const keywordIds = JSON.stringify(uniqueIds(updated.keywordIds ?? []));
    await this.executeCommand(sql`
      INSERT INTO persons (id, updated_at, keyword_ids, payload) VALUES (${updated.id}, ${updated.modifiedAt ?? 0}, ${keywordIds}, ${JSON.stringify(updated)})
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
      INSERT INTO keywords (id, updated_at, payload) VALUES (${updated.id}, ${updated.modifiedAt ?? 0}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
  }

  async deleteKeyword(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keywords WHERE id = ${id}`);
  }

  async clearKeywords(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keywords`);
  }

  async getKeywordVector(keywordId: string): Promise<KeywordVector | undefined> {
    await this.ensureReady();
    const rows = this.sqliteRaw
      ? await this.queryRows(sql`
        SELECT keyword_id, x, y, vector_f32, projection_f32, updated_at
        FROM keyword_vectors
        WHERE keyword_id = ${keywordId}
      `)
      : await this.queryRows(sql`
        SELECT keyword_id, x, y, vector64::text AS vector64, projection2d::text AS projection2d, updated_at
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
    const rows = this.sqliteRaw
      ? await this.queryRows(sql.raw(`
        SELECT keyword_id, x, y, vector_f32, projection_f32, updated_at
        FROM keyword_vectors
        WHERE keyword_id IN (${escapedIds})
      `))
      : await this.queryRows(sql.raw(`
        SELECT keyword_id, x, y, vector64::text AS vector64, projection2d::text AS projection2d, updated_at
        FROM keyword_vectors
        WHERE keyword_id IN (${escapedIds})
      `));
    return rows.map((row) => this.parseKeywordVectorRow(row));
  }

  async listKeywordVectors(): Promise<KeywordVector[]> {
    await this.ensureReady();
    const rows = this.sqliteRaw
      ? await this.queryRows(sql`
        SELECT keyword_id, x, y, vector_f32, projection_f32, updated_at
        FROM keyword_vectors
        ORDER BY updated_at DESC, keyword_id DESC
      `)
      : await this.queryRows(sql`
        SELECT keyword_id, x, y, vector64::text AS vector64, projection2d::text AS projection2d, updated_at
        FROM keyword_vectors
        ORDER BY updated_at DESC, keyword_id DESC
      `);
    return rows.map((row) => this.parseKeywordVectorRow(row));
  }

  async putKeywordVector(vector: KeywordVector): Promise<void> {
    await this.putKeywordVectors([vector]);
  }

  async putKeywordVectors(vectors: KeywordVector[]): Promise<void> {
    await this.ensureReady();
    if (vectors.length === 0) return;

    if (this.sqliteRaw) {
      const stmt = this.sqliteRaw.prepare(`
        INSERT INTO keyword_vectors (keyword_id, x, y, vector_f32, projection_f32, updated_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(keyword_id) DO UPDATE SET
          x = excluded.x,
          y = excluded.y,
          vector_f32 = excluded.vector_f32,
          projection_f32 = excluded.projection_f32,
          updated_at = excluded.updated_at,
          payload = excluded.payload
      `);
      const vecStmt = this.sqliteVecEnabled
        ? this.sqliteRaw.prepare(`
          INSERT INTO keyword_vectors_vec(keyword_id, embedding)
          VALUES (?, ?)
          ON CONFLICT(keyword_id) DO UPDATE SET embedding = excluded.embedding
        `)
        : null;
      const tx = this.sqliteRaw.transaction((items: KeywordVector[]) => {
        for (const vector of items) {
          const embeddingBlob = floatArrayToBuffer(vector.vector64, LATENT_DIM);
          stmt.run(
            vector.keywordId,
            vector.x,
            vector.y,
            embeddingBlob,
            floatArrayToBuffer([vector.x, vector.y], PROJECTION_DIM),
            vector.updatedAt,
            JSON.stringify(vector),
          );
          vecStmt?.run(vector.keywordId, embeddingBlob);
        }
      });
      tx(vectors);
      return;
    }

    if (this.pgPool) {
      const keywordIds: string[] = [];
      const xs: number[] = [];
      const ys: number[] = [];
      const vector64Literals: string[] = [];
      const projection2dLiterals: string[] = [];
      const updatedAts: number[] = [];
      const payloads: string[] = [];

      for (const vector of vectors) {
        keywordIds.push(vector.keywordId);
        xs.push(vector.x);
        ys.push(vector.y);
        vector64Literals.push(toPgVectorLiteral(vector.vector64, LATENT_DIM));
        projection2dLiterals.push(toPgVectorLiteral([vector.x, vector.y], PROJECTION_DIM));
        updatedAts.push(vector.updatedAt);
        payloads.push(JSON.stringify(vector));
      }

      await this.pgPool.query(
        `
          INSERT INTO keyword_vectors (keyword_id, x, y, vector64, projection2d, updated_at, payload)
          SELECT t.keyword_id, t.x, t.y, t.vector64_text::vector(64), t.projection2d_text::vector(2), t.updated_at, t.payload::jsonb
          FROM UNNEST($1::text[], $2::double precision[], $3::double precision[], $4::text[], $5::text[], $6::bigint[], $7::text[])
            AS t(keyword_id, x, y, vector64_text, projection2d_text, updated_at, payload)
          ON CONFLICT(keyword_id) DO UPDATE SET
            x = excluded.x,
            y = excluded.y,
            vector64 = excluded.vector64,
            projection2d = excluded.projection2d,
            updated_at = excluded.updated_at,
            payload = excluded.payload
        `,
        [keywordIds, xs, ys, vector64Literals, projection2dLiterals, updatedAts, payloads],
      );
    }
  }

  async deleteKeywordVector(keywordId: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keyword_vectors WHERE keyword_id = ${keywordId}`);
    if (this.sqliteRaw && this.sqliteVecEnabled) {
      this.sqliteRaw.prepare('DELETE FROM keyword_vectors_vec WHERE keyword_id = ?').run(keywordId);
    }
  }

  async clearKeywordVectors(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM keyword_vectors`);
    if (this.sqliteRaw && this.sqliteVecEnabled) {
      this.sqliteRaw.prepare('DELETE FROM keyword_vectors_vec').run();
    }
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
      INSERT INTO configs (id, updated_at, payload) VALUES (${updated.id}, ${updated.modifiedAt ?? 0}, ${JSON.stringify(updated)})
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
    const payload = this.parsePayload<ScheduleConstraint>(String(row.payload));
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
      const payload = this.parsePayload<ScheduleConstraint>(String(row.payload));
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
    await this.executeCommand(sql`
      INSERT INTO constraints (id, config_id, type, person_ids, payload, created_at, updated_at)
      VALUES (${updated.id}, ${updated.configId}, ${updated.type}, ${personIds}, ${JSON.stringify(updated)}, ${updated.modifiedAt ?? 0}, ${updated.modifiedAt ?? 0})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        type = excluded.type,
        person_ids = excluded.person_ids,
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
      WHERE config_id = ${configId} OR config_id = ''
      ORDER BY updated_at DESC, id DESC
    `);
    return rows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(String(row.payload));
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
      VALUES (${updated.id}, ${updated.configId}, ${updated.modifiedAt ?? 0}, ${JSON.stringify(updated)})
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
    const updated = { ...schedule, modifiedAt: schedule.modifiedAt ?? nowMs() };
    const personIds = JSON.stringify(extractSchedulePersonIds(updated));
    await this.executeCommand(sql`
      INSERT INTO schedules (id, config_id, created_at, updated_at, person_ids, payload)
      VALUES (${updated.id}, ${updated.configId}, ${updated.createdAt}, ${updated.modifiedAt ?? 0}, ${personIds}, ${JSON.stringify(updated)})
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
    const payload = await this.getPayload<PersonUnavailability>(sql`SELECT payload FROM unavailabilities WHERE id = ${id}`);
    if (!payload) return undefined;
    const personIds = normalizeUnavailabilityPersonIds(payload);
    return ({
      ...payload,
      personId: personIds[0],
      personIds,
    } as PersonUnavailability);
  }

  async listUnavailabilities(): Promise<PersonUnavailability[]> {
    await this.ensureReady();
    const values = await this.listPayloads<PersonUnavailability>(sql`SELECT payload FROM unavailabilities ORDER BY start_date, end_date, id`);
    return values.map((value) => {
      const personIds = normalizeUnavailabilityPersonIds(value);
      return ({
        ...value,
        personId: personIds[0],
        personIds,
      } as PersonUnavailability);
    });
  }

  async putUnavailability(unavailability: PersonUnavailability): Promise<void> {
    await this.ensureReady();
    const personIds = normalizeUnavailabilityPersonIds(unavailability);
    const normalized: PersonUnavailability = {
      ...unavailability,
      personId: personIds[0],
      personIds,
    } as PersonUnavailability;
    await this.executeCommand(sql`
      INSERT INTO unavailabilities (id, person_id, person_ids, config_id, start_date, end_date, payload)
      VALUES (
        ${normalized.id},
        ${normalized.personId ?? ''},
        ${JSON.stringify(personIds)},
        ${normalized.configId},
        ${normalized.startDate},
        ${normalized.endDate},
        ${JSON.stringify(normalized)}
      )
      ON CONFLICT(id) DO UPDATE SET
        person_id = excluded.person_id,
        person_ids = excluded.person_ids,
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
    const schedules = scheduleRows.map((row) => this.parsePayload<SchedulePlan>(String(row.payload)));

    const constraintRows = await this.queryRows(sql.raw(`
      SELECT id, config_id, payload, person_ids
      FROM constraints
      WHERE config_id IN (${configInList}) OR config_id = ''
      ORDER BY updated_at DESC, id DESC
    `));
    const constraints = constraintRows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(String(row.payload));
      return {
        ...payload,
        id: String(payload.id ?? row.id),
        configId: String(row.config_id ?? payload.configId ?? ''),
      };
    });

    const unavailabilityRows = await this.queryRows(sql.raw(`
      SELECT payload, person_ids
      FROM unavailabilities
      WHERE config_id IN (${configInList})
      ORDER BY start_date, end_date, id
    `));
    const unavailabilities = unavailabilityRows.map((row) => {
      const payload = this.parsePayload<PersonUnavailability>(String(row.payload));
      const personIds = normalizeUnavailabilityPersonIds(payload);
      return ({
        ...payload,
        personId: personIds[0],
        personIds,
      } as PersonUnavailability);
    });

    const personIdSet = new Set<string>();
    for (const row of scheduleRows) {
      const ids = (() => {
        try {
          return uniqueIds(JSON.parse(String(row.person_ids ?? '[]')) as string[]);
        } catch {
          return [];
        }
      })();
      for (const id of ids) personIdSet.add(id);
    }
    for (const row of constraintRows) {
      const ids = (() => {
        try {
          return uniqueIds(JSON.parse(String(row.person_ids ?? '[]')) as string[]);
        } catch {
          return [];
        }
      })();
      for (const id of ids) personIdSet.add(id);
    }
    for (const row of unavailabilityRows) {
      const ids = (() => {
        try {
          return uniqueIds(JSON.parse(String(row.person_ids ?? '[]')) as string[]);
        } catch {
          return [];
        }
      })();
      for (const id of ids) personIdSet.add(id);
    }

    const persons = await this.listPayloadsByIds<Person>('persons', 'id', [...personIdSet]);
    const keywordIdSet = new Set<string>();
    for (const person of persons) {
      for (const keywordId of person.keywordIds ?? []) keywordIdSet.add(keywordId);
    }
    const keywordIds = [...keywordIdSet];
    const [keywords, keywordVectors] = await Promise.all([
      this.listPayloadsByIds<Keyword>('keywords', 'id', keywordIds),
      this.getKeywordVectors(keywordIds),
    ]);

    return {
      persons,
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
    if (personIds.length === 0) {
      return {
        keywords: [],
        constraints: [],
        schedules: [],
        unavailabilities: [],
      };
    }

    const persons = await this.listPayloadsByIds<Person>('persons', 'id', personIds);
    const keywordIdSet = new Set<string>();
    for (const person of persons) {
      for (const keywordId of person.keywordIds ?? []) keywordIdSet.add(keywordId);
    }
    const keywords = await this.listPayloadsByIds<Keyword>('keywords', 'id', [...keywordIdSet]);

    const overlapCondition = this.buildJsonArrayOverlapCondition('person_ids', personIds);

    const scheduleRows = await this.queryRows(sql.raw(`
      SELECT payload
      FROM schedules
      WHERE ${overlapCondition}
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `));
    const schedules = scheduleRows.map((row) => this.parsePayload<SchedulePlan>(String(row.payload)));

    const constraintRows = await this.queryRows(sql.raw(`
      SELECT id, config_id, payload
      FROM constraints
      WHERE ${overlapCondition}
      ORDER BY updated_at DESC, id DESC
    `));
    const constraints = constraintRows.map((row) => {
      const payload = this.parsePayload<ScheduleConstraint>(String(row.payload));
      return {
        ...payload,
        id: String(payload.id ?? row.id),
        configId: String(row.config_id ?? payload.configId ?? ''),
      };
    });

    const unavailabilityRows = await this.queryRows(sql.raw(`
      SELECT payload
      FROM unavailabilities
      WHERE ${overlapCondition}
      ORDER BY start_date, end_date, id
    `));
    const unavailabilities = unavailabilityRows.map((row) => {
      const payload = this.parsePayload<PersonUnavailability>(String(row.payload));
      const normalizedIds = normalizeUnavailabilityPersonIds(payload);
      return ({
        ...payload,
        personId: normalizedIds[0],
        personIds: normalizedIds,
      } as PersonUnavailability);
    });

    return {
      keywords,
      constraints,
      schedules,
      unavailabilities,
    };
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
    const persons = personRows.map((row) => this.parsePayload<Person>(String(row.payload)));

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
        ${user.createdAt},
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
        ${record.expiresAt},
        ${record.createdAt},
        ${record.revokedAt},
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
      SET revoked_at = coalesce(revoked_at, ${now})
      WHERE user_id = ${userId}
    `);
  }

  async pruneExpiredRefreshTokens(now = Date.now()): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM refresh_tokens WHERE expires_at < ${now} OR revoked_at IS NOT NULL`);
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
        ${record.expiresAt},
        ${record.createdAt},
        ${record.consumedAt},
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
          AND expires_at > ${now}
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
          AND expires_at > ${now}
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
      SET consumed_at = coalesce(consumed_at, ${consumedAt})
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
      WHERE (consumed_at IS NOT NULL AND consumed_at < ${consumedBefore})
         OR (expires_at < ${now} AND created_at < ${expiredCreatedBefore})
    `);
  }

  async exportBackupSnapshot(): Promise<DatabaseBackupSnapshot> {
    await this.ensureReady();
    return {
      version: 1,
      createdAt: Date.now(),
      tables: {
        persons: await this.exportTable('persons'),
        keywords: await this.exportTable('keywords'),
        keywordVectors: await this.exportTable('keyword_vectors'),
        configs: await this.exportTable('configs'),
        constraints: await this.exportTable('constraints'),
        schedules: await this.exportTable('schedules'),
        unavailabilities: await this.exportTable('unavailabilities'),
        emailTasks: await this.exportTable('email_tasks'),
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

    if (snapshotObject.version !== 1) {
      throw new Error('Unsupported backup snapshot version');
    }
    if (!snapshotObject.tables || typeof snapshotObject.tables !== 'object' || Array.isArray(snapshotObject.tables)) {
      throw new Error('Invalid backup payload: missing tables');
    }

    const tables = {
      persons: this.validateTableRows('persons', snapshotObject.tables.persons),
      keywords: this.validateTableRows('keywords', snapshotObject.tables.keywords),
      keyword_vectors: this.normalizeKeywordVectorBackupRows(
        this.validateTableRows('keyword_vectors', snapshotObject.tables.keywordVectors),
      ),
      configs: this.validateTableRows('configs', snapshotObject.tables.configs),
      constraints: this.validateTableRows('constraints', snapshotObject.tables.constraints ?? []),
      schedules: this.validateTableRows('schedules', snapshotObject.tables.schedules),
      unavailabilities: this.validateTableRows('unavailabilities', snapshotObject.tables.unavailabilities),
      email_tasks: this.validateTableRows('email_tasks', snapshotObject.tables.emailTasks),
      users: this.validateTableRows('users', snapshotObject.tables.users),
      refresh_tokens: this.validateTableRows('refresh_tokens', snapshotObject.tables.refreshTokens),
      auth_verification_codes: this.validateTableRows(
        'auth_verification_codes',
        snapshotObject.tables.authVerificationCodes ?? [],
      ),
    };

    await this.run(`
      DELETE FROM refresh_tokens;
      DELETE FROM auth_verification_codes;
      DELETE FROM users;
      DELETE FROM keyword_vectors;
      DELETE FROM email_tasks;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
      DELETE FROM constraints;
      DELETE FROM configs;
      DELETE FROM keywords;
      DELETE FROM persons;
    `);

    await this.restoreTableRows('persons', tables.persons);
    await this.restoreTableRows('keywords', tables.keywords);
    await this.restoreTableRows('keyword_vectors', tables.keyword_vectors);
    await this.restoreTableRows('configs', tables.configs);
    await this.restoreTableRows('constraints', tables.constraints);
    await this.restoreTableRows('schedules', tables.schedules);
    await this.restoreTableRows('unavailabilities', tables.unavailabilities);
    await this.restoreTableRows('email_tasks', tables.email_tasks);
    await this.restoreTableRows('users', tables.users);
    await this.restoreTableRows('refresh_tokens', tables.refresh_tokens);
    await this.restoreTableRows('auth_verification_codes', tables.auth_verification_codes);
    await this.backfillForeignKeyColumns();
  }

  async restoreEntityDump(dump: unknown): Promise<void> {
    await this.ensureReady();

    if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
      throw new Error('Invalid backup payload: expected an object');
    }

    const dumpObject = dump as {
      persons?: unknown;
      keywords?: unknown;
      keywordVectors?: unknown;
      configs?: unknown;
      constraints?: unknown;
      schedules?: unknown;
      unavailabilities?: unknown;
      emailTasks?: unknown;
    };

    const missings = [
      !Array.isArray(dumpObject.persons),
      !Array.isArray(dumpObject.keywords),
      !Array.isArray(dumpObject.keywordVectors),
      !Array.isArray(dumpObject.configs),
      !Array.isArray(dumpObject.constraints),
      !Array.isArray(dumpObject.schedules),
      !Array.isArray(dumpObject.unavailabilities),
      !Array.isArray(dumpObject.emailTasks),
    ];

    if (missings.some((missing) => missing)) {
      console.warn('Warning: backup payload is missing some entity arrays or has invalid formats. Missing entities:', {
        persons: missings[0],
        keywords: missings[1],
        keywordVectors: missings[2],
        configs: missings[3],
        constraints: missings[4],
        schedules: missings[5],
        unavailabilities: missings[6],
        emailTasks: missings[7],
      });
    }

    const persons = dumpObject.persons as Person[] ?? [];
    const keywords = dumpObject.keywords as Keyword[] ?? [];
    const keywordVectors = dumpObject.keywordVectors as KeywordVector[] ?? [];
    const configs = dumpObject.configs as ScheduleConfig[] ?? [];
    const constraints = dumpObject.constraints as ScheduleConstraint[] ?? [];
    const schedules = dumpObject.schedules as SchedulePlan[] ?? [];
    const unavailabilities = dumpObject.unavailabilities as PersonUnavailability[] ?? [];
    const emailTasks = dumpObject.emailTasks as EmailTask[] ?? [];

    await this.clearAllEntityData();

    for (const person of persons) {
      await this.putPerson(person);
    }
    for (const keyword of keywords) {
      await this.putKeyword(keyword);
    }
    for (const vector of keywordVectors) {
      await this.putKeywordVector(vector);
    }
    for (const config of configs) {
      await this.putConfig(config);
    }
    for (const constraint of constraints) {
      await this.putConstraint(constraint);
    }
    for (const schedule of schedules) {
      await this.putSchedule(schedule);
    }
    for (const unavailability of unavailabilities) {
      await this.putUnavailability(unavailability);
    }
    for (const task of emailTasks) {
      await this.putEmailTask(task);
    }
    await this.backfillForeignKeyColumns();
  }

  async restoreFromSqliteFile(sourcePath: string): Promise<void> {
    await this.ensureReady();

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      let constraintsRows: unknown[] = [];
      let authVerificationCodeRows: unknown[] = [];
      try {
        constraintsRows = source.prepare('SELECT * FROM constraints').all();
      } catch {
        constraintsRows = [];
      }
      try {
        authVerificationCodeRows = source.prepare('SELECT * FROM auth_verification_codes').all();
      } catch {
        authVerificationCodeRows = [];
      }
      const snapshot = {
        version: 1,
        tables: {
          persons: source.prepare('SELECT * FROM persons').all(),
          keywords: source.prepare('SELECT * FROM keywords').all(),
          keywordVectors: source.prepare('SELECT * FROM keyword_vectors').all(),
          configs: source.prepare('SELECT * FROM configs').all(),
          constraints: constraintsRows,
          schedules: source.prepare('SELECT * FROM schedules').all(),
          unavailabilities: source.prepare('SELECT * FROM unavailabilities').all(),
          emailTasks: source.prepare('SELECT * FROM email_tasks').all(),
          users: source.prepare('SELECT * FROM users').all(),
          refreshTokens: source.prepare('SELECT * FROM refresh_tokens').all(),
          authVerificationCodes: authVerificationCodeRows,
        },
      };
      await this.restoreBackupSnapshot(snapshot);
    } finally {
      source.close();
    }
  }

  async backupDatabase(destinationPath: string): Promise<void> {
    await this.ensureReady();

    if (this.dialect !== 'sqlite' || !this.sqliteRaw) {
      throw new Error('SQLite binary backup is only supported when store dialect is sqlite');
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    await this.sqliteRaw.backup(destinationPath);
  }

  getDialect(): StoreConnectionConfig['dialect'] {
    return this.dialect;
  }

  async close(): Promise<void> {
    await this.ensureReady();
    this.sqliteRaw?.close();
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}
