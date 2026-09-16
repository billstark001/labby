CREATE TABLE embedding_migration_archive (
  keyword_id text PRIMARY KEY,
  source jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO embedding_migration_archive(keyword_id, source)
SELECT keyword_id, to_jsonb(keyword_vectors) FROM keyword_vectors;
ALTER TABLE keyword_vectors ADD COLUMN embedding jsonb, ADD COLUMN geometry jsonb;
