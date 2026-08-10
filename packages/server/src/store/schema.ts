import { sql } from 'drizzle-orm';

const SCHEMA_SQL = `
  CREATE TABLE persons (
    id TEXT PRIMARY KEY,
    updated_at BIGINT NOT NULL DEFAULT 0,
    keyword_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL
  );

  CREATE TABLE keywords (
    id TEXT PRIMARY KEY,
    updated_at BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL
  );

  CREATE TABLE keyword_relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    directed BOOLEAN NOT NULL DEFAULT FALSE,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (source_id, target_id, kind)
  );

  CREATE TABLE configs (
    id TEXT PRIMARY KEY,
    updated_at BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL
  );

  CREATE TABLE constraints (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL,
    type TEXT NOT NULL,
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT 0,
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL
  );

  CREATE TABLE unavailabilities (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    config_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE TABLE email_tasks (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL
  );

  CREATE TABLE system_settings (
    id TEXT PRIMARY KEY,
    updated_at BIGINT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    role INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE TABLE refresh_tokens (
    token_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    replaced_by_token_id TEXT,
    payload JSONB NOT NULL
  );

  CREATE TABLE auth_verification_codes (
    token_id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_email TEXT NOT NULL,
    pending_email TEXT,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    consumed_at BIGINT,
    payload JSONB NOT NULL
  );

  CREATE TABLE keyword_vectors (
    keyword_id TEXT PRIMARY KEY REFERENCES keywords(id) ON DELETE CASCADE,
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    vector64 vector(64) NOT NULL,
    projection2d vector(2) NOT NULL,
    updated_at BIGINT NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE INDEX persons_updated_at_idx ON persons (updated_at DESC, id DESC);
  CREATE INDEX keywords_updated_at_idx ON keywords (updated_at DESC, id DESC);
  CREATE INDEX keyword_relations_source_idx ON keyword_relations (source_id, kind);
  CREATE INDEX keyword_relations_target_idx ON keyword_relations (target_id, kind);
  CREATE INDEX configs_updated_at_idx ON configs (updated_at DESC, id DESC);
  CREATE INDEX constraints_config_idx ON constraints (config_id);
  CREATE INDEX constraints_updated_at_idx ON constraints (updated_at DESC, id DESC);
  CREATE INDEX schedules_created_at_idx ON schedules (created_at DESC, id DESC);
  CREATE INDEX schedules_updated_at_idx ON schedules (updated_at DESC, id DESC);
  CREATE INDEX unavailabilities_person_idx ON unavailabilities (person_id);
  CREATE INDEX unavailabilities_config_idx ON unavailabilities (config_id);
  CREATE INDEX email_tasks_config_idx ON email_tasks (config_id);
  CREATE INDEX email_tasks_updated_at_idx ON email_tasks (updated_at DESC, id DESC);
  CREATE INDEX system_settings_updated_at_idx ON system_settings (updated_at DESC, id DESC);
  CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
  CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);
  CREATE INDEX auth_verification_codes_user_idx ON auth_verification_codes (user_id, purpose, created_at DESC);
  CREATE INDEX auth_verification_codes_email_idx ON auth_verification_codes (target_email, purpose, created_at DESC);
  CREATE INDEX auth_verification_codes_expires_idx ON auth_verification_codes (expires_at);
`;

type ExecuteCommand = (query: ReturnType<typeof sql>) => Promise<void>;

export async function initializePostgresSchema(executeCommand: ExecuteCommand): Promise<void> {
  await executeCommand(sql.raw('CREATE EXTENSION vector;'));
  for (const statement of SCHEMA_SQL
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await executeCommand(sql.raw(`${statement};`));
  }
}
