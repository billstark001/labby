import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type {
  Keyword,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
  SimilarityEdge,
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
    similarities: Array<Record<string, string | number | null>>;
    configs: Array<Record<string, string | number | null>>;
    schedules: Array<Record<string, string | number | null>>;
    unavailabilities: Array<Record<string, string | number | null>>;
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

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

function normalizeEdge(edge: SimilarityEdge): SimilarityEdge {
  if (edge.sourceId <= edge.targetId) return edge;
  return {
    sourceId: edge.targetId,
    targetId: edge.sourceId,
    weight: edge.weight,
  };
}

function toSqlitePath(input: string): string {
  return input;
}

function valueToTableValue(value: unknown): TableRowValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

export class SqliteStore {
  private readonly sqliteDb: SqliteDrizzleDb | null;
  private readonly pgDb: PostgresDrizzleDb | null;
  private readonly sqliteRaw: Database.Database | null;
  private readonly pgPool: Pool | null;
  private readonly dialect: StoreConnectionConfig['dialect'];
  private readonly ready: Promise<void>;

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
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keywords (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS similarities (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        weight DOUBLE PRECISION NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id)
      );

      CREATE TABLE IF NOT EXISTS configs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_created_at_idx ON schedules (created_at);

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
      this.sqliteRaw.exec(migrationSql);
      return;
    }

    for (const statement of migrationSql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await this.executeCommand(sql.raw(`${statement};`));
    }
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
      DELETE FROM similarities;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
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
    return this.listPayloads<Person>(sql`SELECT payload FROM persons ORDER BY id`);
  }

  async putPerson(person: Person): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO persons (id, payload) VALUES (${person.id}, ${JSON.stringify(person)})
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
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
    return this.listPayloads<Keyword>(sql`SELECT payload FROM keywords ORDER BY id`);
  }

  async putKeyword(keyword: Keyword): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO keywords (id, payload) VALUES (${keyword.id}, ${JSON.stringify(keyword)})
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
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

  async getSimilarity(sourceId: string, targetId: string): Promise<SimilarityEdge | undefined> {
    await this.ensureReady();
    const normalized = normalizeEdge({ sourceId, targetId, weight: 0 });
    return this.getPayload<SimilarityEdge>(
      sql`SELECT payload FROM similarities WHERE source_id = ${normalized.sourceId} AND target_id = ${normalized.targetId}`,
    );
  }

  async listSimilarities(): Promise<SimilarityEdge[]> {
    await this.ensureReady();
    return this.listPayloads<SimilarityEdge>(sql`SELECT payload FROM similarities ORDER BY source_id, target_id`);
  }

  async putSimilarity(edge: SimilarityEdge): Promise<void> {
    await this.ensureReady();
    const normalized = normalizeEdge(edge);
    await this.executeCommand(sql`
      INSERT INTO similarities (source_id, target_id, weight, payload)
      VALUES (${normalized.sourceId}, ${normalized.targetId}, ${normalized.weight}, ${JSON.stringify(normalized)})
      ON CONFLICT(source_id, target_id) DO UPDATE SET
        weight = excluded.weight,
        payload = excluded.payload
    `);
  }

  async deleteSimilarity(sourceId: string, targetId: string): Promise<void> {
    await this.ensureReady();
    const normalized = normalizeEdge({ sourceId, targetId, weight: 0 });
    await this.executeCommand(sql`DELETE FROM similarities WHERE source_id = ${normalized.sourceId} AND target_id = ${normalized.targetId}`);
  }

  async clearSimilarities(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM similarities`);
  }

  async getConfig(id: string): Promise<ScheduleConfig | undefined> {
    await this.ensureReady();
    return this.getPayload<ScheduleConfig>(sql`SELECT payload FROM configs WHERE id = ${id}`);
  }

  async listConfigs(): Promise<ScheduleConfig[]> {
    await this.ensureReady();
    return this.listPayloads<ScheduleConfig>(sql`SELECT payload FROM configs ORDER BY id`);
  }

  async putConfig(config: ScheduleConfig): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO configs (id, payload) VALUES (${config.id}, ${JSON.stringify(config)})
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `);
  }

  async deleteConfig(id: string): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM configs WHERE id = ${id}`);
  }

  async clearConfigs(): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`DELETE FROM configs`);
  }

  async getSchedule(id: string): Promise<SchedulePlan | undefined> {
    await this.ensureReady();
    return this.getPayload<SchedulePlan>(sql`SELECT payload FROM schedules WHERE id = ${id}`);
  }

  async listSchedules(): Promise<SchedulePlan[]> {
    await this.ensureReady();
    return this.listPayloads<SchedulePlan>(sql`SELECT payload FROM schedules ORDER BY created_at DESC, id DESC`);
  }

  async putSchedule(schedule: SchedulePlan): Promise<void> {
    await this.ensureReady();
    await this.executeCommand(sql`
      INSERT INTO schedules (id, config_id, created_at, payload)
      VALUES (${schedule.id}, ${schedule.configId}, ${schedule.createdAt}, ${JSON.stringify(schedule)})
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        created_at = excluded.created_at,
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

  async createUserIfMissing(user: StoredUser): Promise<StoredUser> {
    await this.ensureReady();
    const existing = await this.findUserByIdentity(user.email ?? user.username);
    if (existing) return existing;

    await this.createUser(user);
    return user;
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
        similarities: await this.exportTable('similarities'),
        configs: await this.exportTable('configs'),
        schedules: await this.exportTable('schedules'),
        unavailabilities: await this.exportTable('unavailabilities'),
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
      similarities: this.validateTableRows('similarities', snapshotObject.tables.similarities),
      configs: this.validateTableRows('configs', snapshotObject.tables.configs),
      schedules: this.validateTableRows('schedules', snapshotObject.tables.schedules),
      unavailabilities: this.validateTableRows('unavailabilities', snapshotObject.tables.unavailabilities),
      users: this.validateTableRows('users', snapshotObject.tables.users),
      refresh_tokens: this.validateTableRows('refresh_tokens', snapshotObject.tables.refreshTokens),
    };

    await this.run(`
      DELETE FROM refresh_tokens;
      DELETE FROM users;
      DELETE FROM similarities;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
      DELETE FROM configs;
      DELETE FROM keywords;
      DELETE FROM persons;
    `);

    await this.restoreTableRows('persons', tables.persons);
    await this.restoreTableRows('keywords', tables.keywords);
    await this.restoreTableRows('similarities', tables.similarities);
    await this.restoreTableRows('configs', tables.configs);
    await this.restoreTableRows('schedules', tables.schedules);
    await this.restoreTableRows('unavailabilities', tables.unavailabilities);
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
      similarities?: unknown;
      configs?: unknown;
      schedules?: unknown;
      unavailabilities?: unknown;
    };

    if (!Array.isArray(dumpObject.persons)
      || !Array.isArray(dumpObject.keywords)
      || !Array.isArray(dumpObject.similarities)
      || !Array.isArray(dumpObject.configs)
      || !Array.isArray(dumpObject.schedules)
      || !Array.isArray(dumpObject.unavailabilities)) {
      throw new Error('Invalid backup payload: missing entity lists');
    }

    const persons = dumpObject.persons as Person[];
    const keywords = dumpObject.keywords as Keyword[];
    const similarities = dumpObject.similarities as SimilarityEdge[];
    const configs = dumpObject.configs as ScheduleConfig[];
    const schedules = dumpObject.schedules as SchedulePlan[];
    const unavailabilities = dumpObject.unavailabilities as PersonUnavailability[];

    await this.clearAllEntityData();

    for (const person of persons) {
      await this.putPerson(person);
    }
    for (const keyword of keywords) {
      await this.putKeyword(keyword);
    }
    for (const edge of similarities) {
      await this.putSimilarity(edge);
    }
    for (const config of configs) {
      await this.putConfig(config);
    }
    for (const schedule of schedules) {
      await this.putSchedule(schedule);
    }
    for (const unavailability of unavailabilities) {
      await this.putUnavailability(unavailability);
    }
  }

  async restoreFromSqliteFile(sourcePath: string): Promise<void> {
    await this.ensureReady();

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const snapshot = {
        version: 1,
        tables: {
          persons: source.prepare('SELECT * FROM persons').all(),
          keywords: source.prepare('SELECT * FROM keywords').all(),
          similarities: source.prepare('SELECT * FROM similarities').all(),
          configs: source.prepare('SELECT * FROM configs').all(),
          schedules: source.prepare('SELECT * FROM schedules').all(),
          unavailabilities: source.prepare('SELECT * FROM unavailabilities').all(),
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
