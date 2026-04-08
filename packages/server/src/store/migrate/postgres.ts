import { sql } from 'drizzle-orm';

const POSTGRES_COMMON_SQL = `
  CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    updated_at BIGINT NOT NULL DEFAULT 0,
    keyword_ids TEXT NOT NULL DEFAULT '[]',
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
    person_ids TEXT NOT NULL DEFAULT '[]',
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
    person_ids TEXT NOT NULL DEFAULT '[]',
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS schedules_created_at_idx ON schedules (created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS schedules_updated_at_idx ON schedules (updated_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS unavailabilities (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    person_ids TEXT NOT NULL DEFAULT '[]',
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

type ExecuteCommand = (query: ReturnType<typeof sql>) => Promise<void>;

export async function migratePostgres(executeCommand: ExecuteCommand): Promise<void> {
  for (const statement of POSTGRES_COMMON_SQL
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await executeCommand(sql.raw(`${statement};`));
  }

  // Backward-compatible column additions for existing databases.
  const alterStatements = [
    'ALTER TABLE persons ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
    "ALTER TABLE persons ADD COLUMN IF NOT EXISTS keyword_ids TEXT NOT NULL DEFAULT '[]';",
    'ALTER TABLE keywords ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
    'ALTER TABLE configs ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
    "ALTER TABLE constraints ADD COLUMN IF NOT EXISTS person_ids TEXT NOT NULL DEFAULT '[]';",
    'ALTER TABLE schedules ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
    "ALTER TABLE schedules ADD COLUMN IF NOT EXISTS person_ids TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE unavailabilities ADD COLUMN IF NOT EXISTS person_ids TEXT NOT NULL DEFAULT '[]';",
    'ALTER TABLE email_tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;',
  ];
  for (const statement of alterStatements) {
    await executeCommand(sql.raw(statement));
  }

  await executeCommand(sql.raw('CREATE EXTENSION IF NOT EXISTS vector;'));
  await executeCommand(sql.raw(`
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
  await executeCommand(sql.raw(`
    CREATE INDEX IF NOT EXISTS keyword_vectors_vector64_ivfflat_idx
    ON keyword_vectors USING ivfflat (vector64 vector_l2_ops) WITH (lists = 100);
  `));
}
