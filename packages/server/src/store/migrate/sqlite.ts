import Database from 'better-sqlite3';

const SQLITE_COMMON_SQL = `
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

  CREATE TABLE IF NOT EXISTS auth_verification_codes (
    token_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id TEXT,
    target_email TEXT NOT NULL,
    pending_email TEXT,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    consumed_at BIGINT,
    payload TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS auth_verification_codes_user_idx ON auth_verification_codes (user_id, purpose, created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_verification_codes_email_idx ON auth_verification_codes (target_email, purpose, created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_verification_codes_expires_idx ON auth_verification_codes (expires_at);
`;

export function migrateSqlite(rawDb: Database.Database): { sqliteVecEnabled: boolean } {
  rawDb.exec(SQLITE_COMMON_SQL);

  // Backward-compatible column additions for existing databases.
  try { rawDb.exec('ALTER TABLE persons ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
  try { rawDb.exec('ALTER TABLE keywords ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
  try { rawDb.exec('ALTER TABLE configs ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
  try { rawDb.exec('ALTER TABLE schedules ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}
  try { rawDb.exec('ALTER TABLE email_tasks ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;'); } catch {}

  rawDb.exec(`
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
    rawDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS keyword_vectors_vec
      USING vec0(keyword_id TEXT, embedding float[64]);
    `);
    return { sqliteVecEnabled: true };
  } catch {
    // sqlite-vec not available in current runtime; continue with blob storage.
    return { sqliteVecEnabled: false };
  }
}
