import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type {
  EmailTask,
  Keyword,
  KeywordVector,
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
  };
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

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

function nowMs(): number {
  return Date.now();
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
    const commonSql = `
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        updated_at BIGINT NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS persons_updated_at_idx ON persons (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS keywords (
        id TEXT PRIMARY KEY,
        updated_at BIGINT NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS keywords_updated_at_idx ON keywords (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS configs (
        id TEXT PRIMARY KEY,
        updated_at BIGINT NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS configs_updated_at_idx ON configs (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS constraints (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS constraints_config_idx ON constraints (config_id);
      CREATE INDEX IF NOT EXISTS constraints_updated_at_idx ON constraints (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_created_at_idx ON schedules (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS schedules_updated_at_idx ON schedules (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS unavailabilities (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS unavailabilities_person_idx ON unavailabilities (person_id);
      CREATE INDEX IF NOT EXISTS unavailabilities_config_idx ON unavailabilities (config_id);

      CREATE TABLE IF NOT EXISTS email_tasks (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS email_tasks_config_idx ON email_tasks (config_id);
      CREATE INDEX IF NOT EXISTS email_tasks_updated_at_idx ON email_tasks (updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        role INTEGER NOT NULL,
        password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        replaced_by_token_id TEXT,
        payload TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
      CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);
    `;

    if (this.sqliteRaw) {
      this.sqliteRaw.exec(commonSql);
      // Backward-compatible column additions for existing databases.
      try { this.sqliteRaw.exec('ALTER TABLE persons ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
      try { this.sqliteRaw.exec('ALTER TABLE keywords ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
      try { this.sqliteRaw.exec('ALTER TABLE configs ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
      try { this.sqliteRaw.exec('ALTER TABLE schedules ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
      try { this.sqliteRaw.exec('ALTER TABLE email_tasks ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
      this.sqliteRaw.exec(`
        CREATE TABLE IF NOT EXISTS keyword_vectors (
          keyword_id TEXT PRIMARY KEY,
          x DOUBLE PRECISION NOT NULL,
          y DOUBLE PRECISION NOT NULL,
          vector_f32 BLOB NOT NULL,
          projection_f32 BLOB NOT NULL,
          updated_at BIGINT NOT NULL,
          payload TEXT NOT NULL,
          FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
        );
      `);
      // Best effort: if sqlite-vec extension is available, create ANN index table.
      try {
        this.sqliteRaw.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS keyword_vectors_vec
          USING vec0(keyword_id TEXT, embedding float[64]);
        `);
        this.sqliteVecEnabled = true;
      } catch {
        // sqlite-vec not available in current runtime; continue with blob storage.
        this.sqliteVecEnabled = false;
      }
      return;
    }

    for (const statement of commonSql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await this.executeCommand(sql.raw(`${statement};`));
    }

    // Backward-compatible column additions for existing databases.
    const alterStatements = [
      'ALTER TABLE persons ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
      'ALTER TABLE keywords ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
      'ALTER TABLE configs ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
      'ALTER TABLE schedules ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
      'ALTER TABLE email_tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
    ];
    for (const statement of alterStatements) {
      await this.executeCommand(sql.raw(statement));
    }

    await this.executeCommand(sql.raw('CREATE EXTENSION IF NOT EXISTS vector;'));
    await this.executeCommand(sql.raw(`
      CREATE TABLE IF NOT EXISTS keyword_vectors (
        keyword_id TEXT PRIMARY KEY,
        x DOUBLE PRECISION NOT NULL,
        y DOUBLE PRECISION NOT NULL,
        vector64 vector(64) NOT NULL,
        projection2d vector(2) NOT NULL,
        updated_at BIGINT NOT NULL,
        payload JSONB NOT NULL,
        FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
      );
    `));
    await this.executeCommand(sql.raw(`
      CREATE INDEX IF NOT EXISTS keyword_vectors_vector64_ivfflat_idx
      ON keyword_vectors USING ivfflat (vector64 vector_l2_ops) WITH (lists = 100);
    `));
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private parsePayload<T>(payload: string): T {
    return JSON.parse(payload) as T;
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

  async listPersons(): Promise<Person[]> {
    await this.ensureReady();
    return this.listPayloads<Person>(sql`SELECT payload FROM persons ORDER BY updated_at DESC, id DESC`);
  }

  async putPerson(person: Person): Promise<void> {
    await this.ensureReady();
    const updated = { ...person, modifiedAt: person.modifiedAt ?? nowMs() };
    await this.executeCommand(sql`
      INSERT INTO persons (id, updated_at, payload) VALUES (${updated.id}, ${updated.modifiedAt ?? 0}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
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

  async listKeywords(): Promise<Keyword[]> {
    await this.ensureReady();
    return this.listPayloads<Keyword>(sql`SELECT payload FROM keywords ORDER BY updated_at DESC, id DESC`);
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
    await this.executeCommand(sql`
      INSERT INTO constraints (id, config_id, type, payload, created_at, updated_at)
      VALUES (${updated.id}, ${updated.configId}, ${updated.type}, ${JSON.stringify(updated)}, ${updated.modifiedAt ?? 0}, ${updated.modifiedAt ?? 0})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        type = excluded.type,
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
    await this.executeCommand(sql`
      INSERT INTO schedules (id, config_id, created_at, updated_at, payload)
      VALUES (${updated.id}, ${updated.configId}, ${updated.createdAt}, ${updated.modifiedAt ?? 0}, ${JSON.stringify(updated)})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
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
    await this.executeCommand(sql`
      INSERT INTO unavailabilities (id, person_id, config_id, start_date, end_date, payload)
      VALUES (
        ${unavailability.id},
        ${unavailability.personId},
        ${unavailability.configId},
        ${unavailability.startDate},
        ${unavailability.endDate},
        ${JSON.stringify(unavailability)}
      )
      ON CONFLICT(id) DO UPDATE SET
        person_id = excluded.person_id,
        config_id = excluded.config_id,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        payload = excluded.payload
    `);
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
      keyword_vectors: this.validateTableRows('keyword_vectors', snapshotObject.tables.keywordVectors),
      configs: this.validateTableRows('configs', snapshotObject.tables.configs),
      constraints: this.validateTableRows('constraints', snapshotObject.tables.constraints ?? []),
      schedules: this.validateTableRows('schedules', snapshotObject.tables.schedules),
      unavailabilities: this.validateTableRows('unavailabilities', snapshotObject.tables.unavailabilities),
      email_tasks: this.validateTableRows('email_tasks', snapshotObject.tables.emailTasks),
      users: this.validateTableRows('users', snapshotObject.tables.users),
      refresh_tokens: this.validateTableRows('refresh_tokens', snapshotObject.tables.refreshTokens),
    };

    await this.run(`
      DELETE FROM refresh_tokens;
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
  }

  async restoreFromSqliteFile(sourcePath: string): Promise<void> {
    await this.ensureReady();

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      let constraintsRows: unknown[] = [];
      try {
        constraintsRows = source.prepare('SELECT * FROM constraints').all();
      } catch {
        constraintsRows = [];
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

  async close(): Promise<void> {
    await this.ensureReady();
    this.sqliteRaw?.close();
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}
