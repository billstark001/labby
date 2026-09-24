CREATE TABLE persons (
    id UUID PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    keyword_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL
  );

  CREATE TABLE keywords (
    id UUID PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL
  );

  CREATE TABLE keyword_relations (
    id UUID PRIMARY KEY,
    source_id UUID NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    directed BOOLEAN NOT NULL DEFAULT FALSE,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (source_id, target_id, kind)
  );

  CREATE TABLE configs (
    id UUID PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL
  );

  CREATE TABLE constraints (
    id UUID PRIMARY KEY,
    config_id UUID,
    type TEXT NOT NULL,
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    tag_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE schedules (
    id UUID PRIMARY KEY,
    config_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL
  );

  CREATE TABLE unavailabilities (
    id UUID PRIMARY KEY,
    person_id UUID,
    person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    config_id UUID NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE TABLE email_tasks (
    id UUID PRIMARY KEY,
    config_id UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL
  );

  CREATE TABLE system_settings (
    id UUID PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload JSONB NOT NULL
  );

  CREATE TABLE users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    role INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE TABLE refresh_tokens (
    token_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by_token_id UUID,
    payload JSONB NOT NULL
  );

  CREATE TABLE auth_verification_codes (
    token_id UUID PRIMARY KEY,
    purpose TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    target_email TEXT NOT NULL,
    pending_email TEXT,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    payload JSONB NOT NULL
  );

  CREATE TABLE keyword_vectors (
    keyword_id UUID PRIMARY KEY REFERENCES keywords(id) ON DELETE CASCADE,
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    embedding JSONB NOT NULL,
    geometry JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL
  );

  CREATE INDEX persons_updated_at_idx ON persons (updated_at DESC, id DESC);
  CREATE INDEX keywords_updated_at_idx ON keywords (updated_at DESC, id DESC);
  CREATE INDEX keyword_relations_source_idx ON keyword_relations (source_id, kind);
  CREATE INDEX keyword_relations_target_idx ON keyword_relations (target_id, kind);
  CREATE INDEX configs_updated_at_idx ON configs (updated_at DESC, id DESC);
  CREATE INDEX constraints_config_idx ON constraints (config_id);
  CREATE INDEX constraints_updated_at_idx ON constraints (updated_at DESC, id DESC);
  CREATE INDEX constraints_person_ids_gin_idx ON constraints USING gin (person_ids);
  CREATE INDEX constraints_tag_ids_gin_idx ON constraints USING gin (tag_ids);
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

CREATE TABLE embedding_migration_archive (
  keyword_id uuid PRIMARY KEY, source jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE keyword_vectors ADD CONSTRAINT embedding_shape CHECK (
  jsonb_typeof(embedding) = 'array'
  AND jsonb_array_length(embedding) =
    (geometry->>'hyperbolicDimensions')::int + (geometry->>'euclideanDimensions')::int
);
CREATE TABLE ranking_judgments (id uuid PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE graph_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0,
  epoch text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text)
);
INSERT INTO graph_clock(singleton) VALUES(true);
-- Retain deletion tombstones; only the latest change per keyword is needed.
CREATE TABLE graph_changes (
  keyword_id uuid PRIMARY KEY,
  revision bigint NOT NULL UNIQUE
);
CREATE FUNCTION record_graph_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_id uuid;
  next_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'keywords' THEN
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.keyword_id ELSE NEW.keyword_id END;
  END IF;
  -- The clock row serializes writers until commit, avoiding sequence/commit-order gaps.
  UPDATE graph_clock SET revision = revision + 1 WHERE singleton RETURNING revision INTO next_revision;
  INSERT INTO graph_changes(keyword_id, revision) VALUES(changed_id, next_revision)
  ON CONFLICT(keyword_id) DO UPDATE SET revision = excluded.revision;
  RETURN NULL;
END;
$$;
CREATE TRIGGER keywords_graph_change AFTER INSERT OR UPDATE OR DELETE ON keywords
FOR EACH ROW EXECUTE FUNCTION record_graph_change();
CREATE TRIGGER vectors_graph_change AFTER INSERT OR UPDATE OR DELETE ON keyword_vectors
FOR EACH ROW EXECUTE FUNCTION record_graph_change();

CREATE TABLE schema_migrations (
  version integer PRIMARY KEY, name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version,name) VALUES
  (1,'baseline'), (2,'product-embedding-and-ranking-history'), (3,'graph-change-feed'),
  (4,'jsonb-documents'), (5,'uuid-timestamptz-person-tags'),
  (6,'constraint-tag-targets'),
  (7,'localized-person-tags-and-constraint-state');
CREATE INDEX keywords_graph_id_idx ON keywords(id);

CREATE TABLE person_tags (
  id uuid PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX person_tags_updated_at_idx ON person_tags(updated_at DESC,id DESC);
