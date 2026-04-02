import Database from 'better-sqlite3';

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

function openDatabase(dbPath: string) {
  return new Database(dbPath);
}

type TableRowValue = string | number | null;
type TableRow = Record<string, TableRowValue>;

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

export class SqliteStore {
  private readonly db: ReturnType<typeof openDatabase>;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
        weight REAL NOT NULL,
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
        created_at INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        replaced_by_token_id TEXT,
        payload TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
      CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);
    `);
  }

  private parsePayload<T>(payload: string): T {
    return JSON.parse(payload) as T;
  }

  private listPayloads<T>(sql: string, params: unknown[] = []): T[] {
    return (this.db.prepare(sql).all(...params) as Array<{ payload: string }>).map(row => this.parsePayload<T>(row.payload));
  }

  private getPayload<T>(sql: string, params: unknown[] = []): T | undefined {
    const row = this.db.prepare(sql).get(...params) as { payload: string } | undefined;
    return row ? this.parsePayload<T>(row.payload) : undefined;
  }

  private exportTable(tableName: string): Array<Record<string, string | number | null>> {
    return this.db.prepare(`SELECT * FROM ${tableName}`).all() as Array<Record<string, string | number | null>>;
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

  private restoreTableRows(tableName: string, rows: TableRow[]): void {
    if (rows.length === 0) {
      return;
    }

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      throw new Error(`Invalid backup payload: table ${tableName} row has no columns`);
    }

    const quotedColumns = columns.map(column => `"${column}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const statement = this.db.prepare(`INSERT INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`);

    for (const row of rows) {
      const values = columns.map((column) => {
        const value = row[column];
        return value === undefined ? null : value;
      });
      statement.run(...values);
    }
  }

  clearAllEntityData(): void {
    this.db.exec(`
      DELETE FROM similarities;
      DELETE FROM unavailabilities;
      DELETE FROM schedules;
      DELETE FROM configs;
      DELETE FROM keywords;
      DELETE FROM persons;
    `);
  }

  getPerson(id: string): Person | undefined {
    return this.getPayload<Person>('SELECT payload FROM persons WHERE id = ?', [id]);
  }

  listPersons(): Person[] {
    return this.listPayloads<Person>('SELECT payload FROM persons ORDER BY id');
  }

  putPerson(person: Person): void {
    this.db.prepare(`
      INSERT INTO persons (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(person.id, JSON.stringify(person));
  }

  deletePerson(id: string): void {
    this.db.prepare('DELETE FROM persons WHERE id = ?').run(id);
  }

  clearPersons(): void {
    this.db.prepare('DELETE FROM persons').run();
  }

  getKeyword(id: string): Keyword | undefined {
    return this.getPayload<Keyword>('SELECT payload FROM keywords WHERE id = ?', [id]);
  }

  listKeywords(): Keyword[] {
    return this.listPayloads<Keyword>('SELECT payload FROM keywords ORDER BY id');
  }

  putKeyword(keyword: Keyword): void {
    this.db.prepare(`
      INSERT INTO keywords (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(keyword.id, JSON.stringify(keyword));
  }

  deleteKeyword(id: string): void {
    this.db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
  }

  clearKeywords(): void {
    this.db.prepare('DELETE FROM keywords').run();
  }

  getSimilarity(sourceId: string, targetId: string): SimilarityEdge | undefined {
    const normalized = normalizeEdge({ sourceId, targetId, weight: 0 });
    return this.getPayload<SimilarityEdge>(
      'SELECT payload FROM similarities WHERE source_id = ? AND target_id = ?',
      [normalized.sourceId, normalized.targetId],
    );
  }

  listSimilarities(): SimilarityEdge[] {
    return this.listPayloads<SimilarityEdge>('SELECT payload FROM similarities ORDER BY source_id, target_id');
  }

  putSimilarity(edge: SimilarityEdge): void {
    const normalized = normalizeEdge(edge);
    this.db.prepare(`
      INSERT INTO similarities (source_id, target_id, weight, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, target_id) DO UPDATE SET
        weight = excluded.weight,
        payload = excluded.payload
    `).run(
      normalized.sourceId,
      normalized.targetId,
      normalized.weight,
      JSON.stringify(normalized),
    );
  }

  deleteSimilarity(sourceId: string, targetId: string): void {
    const normalized = normalizeEdge({ sourceId, targetId, weight: 0 });
    this.db.prepare('DELETE FROM similarities WHERE source_id = ? AND target_id = ?').run(
      normalized.sourceId,
      normalized.targetId,
    );
  }

  clearSimilarities(): void {
    this.db.prepare('DELETE FROM similarities').run();
  }

  getConfig(id: string): ScheduleConfig | undefined {
    return this.getPayload<ScheduleConfig>('SELECT payload FROM configs WHERE id = ?', [id]);
  }

  listConfigs(): ScheduleConfig[] {
    return this.listPayloads<ScheduleConfig>('SELECT payload FROM configs ORDER BY id');
  }

  putConfig(config: ScheduleConfig): void {
    this.db.prepare(`
      INSERT INTO configs (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(config.id, JSON.stringify(config));
  }

  deleteConfig(id: string): void {
    this.db.prepare('DELETE FROM configs WHERE id = ?').run(id);
  }

  clearConfigs(): void {
    this.db.prepare('DELETE FROM configs').run();
  }

  getSchedule(id: string): SchedulePlan | undefined {
    return this.getPayload<SchedulePlan>('SELECT payload FROM schedules WHERE id = ?', [id]);
  }

  listSchedules(): SchedulePlan[] {
    return this.listPayloads<SchedulePlan>('SELECT payload FROM schedules ORDER BY created_at DESC, id DESC');
  }

  putSchedule(schedule: SchedulePlan): void {
    this.db.prepare(`
      INSERT INTO schedules (id, config_id, created_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config_id = excluded.config_id,
        created_at = excluded.created_at,
        payload = excluded.payload
    `).run(schedule.id, schedule.configId, schedule.createdAt, JSON.stringify(schedule));
  }

  deleteSchedule(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  clearSchedules(): void {
    this.db.prepare('DELETE FROM schedules').run();
  }

  getUnavailability(id: string): PersonUnavailability | undefined {
    return this.getPayload<PersonUnavailability>('SELECT payload FROM unavailabilities WHERE id = ?', [id]);
  }

  listUnavailabilities(): PersonUnavailability[] {
    return this.listPayloads<PersonUnavailability>('SELECT payload FROM unavailabilities ORDER BY start_date, end_date, id');
  }

  putUnavailability(unavailability: PersonUnavailability): void {
    this.db.prepare(`
      INSERT INTO unavailabilities (id, person_id, config_id, start_date, end_date, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        person_id = excluded.person_id,
        config_id = excluded.config_id,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        payload = excluded.payload
    `).run(
      unavailability.id,
      unavailability.personId,
      unavailability.configId,
      unavailability.startDate,
      unavailability.endDate,
      JSON.stringify(unavailability),
    );
  }

  deleteUnavailability(id: string): void {
    this.db.prepare('DELETE FROM unavailabilities WHERE id = ?').run(id);
  }

  clearUnavailabilities(): void {
    this.db.prepare('DELETE FROM unavailabilities').run();
  }

  getUserById(id: string): StoredUser | undefined {
    return this.getPayload<StoredUser>('SELECT payload FROM users WHERE id = ?', [id]);
  }

  findUserByIdentity(identity: string): StoredUser | undefined {
    const normalized = normalizeIdentity(identity);
    return this.getPayload<StoredUser>(
      'SELECT payload FROM users WHERE lower(username) = ? OR lower(coalesce(email, \"\")) = ?',
      [normalized, normalized],
    );
  }

  createUserIfMissing(user: StoredUser): StoredUser {
    const existing = this.findUserByIdentity(user.email ?? user.username);
    if (existing) return existing;

    this.db.prepare(`
      INSERT INTO users (id, username, email, role, password_hash, disabled, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.email ?? null,
      user.role,
      user.passwordHash,
      user.disabled ? 1 : 0,
      user.createdAt,
      JSON.stringify(user),
    );
    return user;
  }

  createUser(user: StoredUser): void {
    this.db.prepare(`
      INSERT INTO users (id, username, email, role, password_hash, disabled, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.email ?? null,
      user.role,
      user.passwordHash,
      user.disabled ? 1 : 0,
      user.createdAt,
      JSON.stringify(user),
    );
  }

  listUsers(): StoredUser[] {
    return (this.db.prepare('SELECT payload FROM users ORDER BY created_at').all() as Array<{ payload: string }>)
      .map(row => this.parsePayload<StoredUser>(row.payload));
  }

  saveRefreshToken(record: RefreshTokenRecord): void {
    this.db.prepare(`
      INSERT INTO refresh_tokens (token_id, user_id, expires_at, created_at, revoked_at, replaced_by_token_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        user_id = excluded.user_id,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        revoked_at = excluded.revoked_at,
        replaced_by_token_id = excluded.replaced_by_token_id,
        payload = excluded.payload
    `).run(
      record.tokenId,
      record.userId,
      record.expiresAt,
      record.createdAt,
      record.revokedAt,
      record.replacedByTokenId,
      JSON.stringify(record),
    );
  }

  getRefreshToken(tokenId: string): RefreshTokenRecord | undefined {
    return this.getPayload<RefreshTokenRecord>('SELECT payload FROM refresh_tokens WHERE token_id = ?', [tokenId]);
  }

  revokeRefreshToken(tokenId: string, replacedByTokenId: string | null = null): void {
    const current = this.getRefreshToken(tokenId);
    if (!current) return;
    const updated: RefreshTokenRecord = {
      ...current,
      revokedAt: current.revokedAt ?? Date.now(),
      replacedByTokenId,
    };
    this.saveRefreshToken(updated);
  }

  revokeAllRefreshTokensForUser(userId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = coalesce(revoked_at, ?)
      WHERE user_id = ?
    `).run(now, userId);
  }

  pruneExpiredRefreshTokens(now = Date.now()): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now);
  }

  exportBackupSnapshot(): DatabaseBackupSnapshot {
    return {
      version: 1,
      createdAt: Date.now(),
      tables: {
        persons: this.exportTable('persons'),
        keywords: this.exportTable('keywords'),
        similarities: this.exportTable('similarities'),
        configs: this.exportTable('configs'),
        schedules: this.exportTable('schedules'),
        unavailabilities: this.exportTable('unavailabilities'),
        users: this.exportTable('users'),
        refreshTokens: this.exportTable('refresh_tokens'),
      },
    };
  }

  restoreBackupSnapshot(snapshot: unknown): void {
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

    const transaction = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM refresh_tokens;
        DELETE FROM users;
        DELETE FROM similarities;
        DELETE FROM unavailabilities;
        DELETE FROM schedules;
        DELETE FROM configs;
        DELETE FROM keywords;
        DELETE FROM persons;
      `);

      this.restoreTableRows('persons', tables.persons);
      this.restoreTableRows('keywords', tables.keywords);
      this.restoreTableRows('similarities', tables.similarities);
      this.restoreTableRows('configs', tables.configs);
      this.restoreTableRows('schedules', tables.schedules);
      this.restoreTableRows('unavailabilities', tables.unavailabilities);
      this.restoreTableRows('users', tables.users);
      this.restoreTableRows('refresh_tokens', tables.refresh_tokens);
    });

    transaction();
  }

  restoreEntityDump(dump: unknown): void {
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

    const transaction = this.db.transaction(() => {
      this.clearAllEntityData();

      for (const person of persons) {
        this.putPerson(person);
      }
      for (const keyword of keywords) {
        this.putKeyword(keyword);
      }
      for (const edge of similarities) {
        this.putSimilarity(edge);
      }
      for (const config of configs) {
        this.putConfig(config);
      }
      for (const schedule of schedules) {
        this.putSchedule(schedule);
      }
      for (const unavailability of unavailabilities) {
        this.putUnavailability(unavailability);
      }
    });

    transaction();
  }

  restoreFromSqliteFile(sourcePath: string): void {
    const source = openDatabase(sourcePath);
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
      this.restoreBackupSnapshot(snapshot);
    } finally {
      source.close();
    }
  }

  async backupDatabase(destinationPath: string): Promise<void> {
    await this.db.backup(destinationPath);
  }
}