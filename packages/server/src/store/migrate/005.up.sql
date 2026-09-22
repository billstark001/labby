-- UUID/timestamptz normalization. Existing non-UUID identifiers are mapped
-- deterministically so retries and independently restored backups agree.
CREATE FUNCTION labby_uuid(value text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE digest text;
BEGIN
  IF value = 'system' THEN RETURN '00000000-0000-4000-8000-000000000001'::uuid; END IF;
  IF value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN value::uuid;
  END IF;
  digest := md5('labby:v5:' || value);
  RETURN (substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
END;
$$;

-- Very early unversioned deployments sometimes lacked later baseline tables or
-- denormalized index columns. Fill those gaps before normalizing their types.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS keyword_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE keywords ADD COLUMN IF NOT EXISTS updated_at bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS keyword_relations (id text PRIMARY KEY,source_id text NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,target_id text NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,kind text NOT NULL,directed boolean NOT NULL DEFAULT false,weight double precision NOT NULL DEFAULT 1,updated_at bigint NOT NULL DEFAULT 0,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,UNIQUE(source_id,target_id,kind));
CREATE TABLE IF NOT EXISTS configs (id text PRIMARY KEY,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS constraints (id text PRIMARY KEY,config_id text NOT NULL,type text NOT NULL,person_ids jsonb NOT NULL DEFAULT '[]',payload jsonb NOT NULL,created_at bigint NOT NULL,updated_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (id text PRIMARY KEY,config_id text NOT NULL,created_at bigint NOT NULL,updated_at bigint NOT NULL DEFAULT 0,person_ids jsonb NOT NULL DEFAULT '[]',payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS unavailabilities (id text PRIMARY KEY,person_id text NOT NULL,person_ids jsonb NOT NULL DEFAULT '[]',config_id text NOT NULL,start_date text NOT NULL,end_date text NOT NULL,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS email_tasks (id text PRIMARY KEY,config_id text NOT NULL,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS system_settings (id text PRIMARY KEY,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY,username text NOT NULL UNIQUE,email text UNIQUE,role integer NOT NULL,password_hash text NOT NULL,disabled integer NOT NULL DEFAULT 0,created_at bigint NOT NULL,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS refresh_tokens (token_id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at bigint NOT NULL,created_at bigint NOT NULL,revoked_at bigint,replaced_by_token_id text,payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS auth_verification_codes (token_id text PRIMARY KEY,purpose text NOT NULL,user_id text REFERENCES users(id) ON DELETE CASCADE,target_email text NOT NULL,pending_email text,code_hash text NOT NULL,expires_at bigint NOT NULL,created_at bigint NOT NULL,consumed_at bigint,payload jsonb NOT NULL);

CREATE TEMP TABLE labby_id_map(old_id text PRIMARY KEY, new_id uuid NOT NULL UNIQUE) ON COMMIT DROP;
INSERT INTO labby_id_map
SELECT old_id, labby_uuid(old_id) FROM (
  SELECT id old_id FROM persons UNION SELECT id FROM keywords UNION SELECT id FROM keyword_relations
  UNION SELECT id FROM configs UNION SELECT id FROM constraints UNION SELECT id FROM schedules
  UNION SELECT id FROM unavailabilities UNION SELECT id FROM email_tasks UNION SELECT id FROM system_settings
  UNION SELECT id FROM users UNION SELECT token_id FROM refresh_tokens UNION SELECT token_id FROM auth_verification_codes
  UNION SELECT id FROM ranking_judgments
) ids WHERE old_id IS NOT NULL AND old_id <> '';

CREATE FUNCTION labby_rewrite_ids(value jsonb, rewrite_strings boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb; replacement uuid;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT jsonb_object_agg(key, labby_rewrite_ids(val, rewrite_strings OR key='id' OR key ~ '(Id|Ids)$' OR key='groups')) INTO result FROM jsonb_each(value) entry(key,val);
      RETURN COALESCE(result, '{}'::jsonb);
    WHEN 'array' THEN
      SELECT jsonb_agg(labby_rewrite_ids(val, rewrite_strings)) INTO result FROM jsonb_array_elements(value) item(val);
      RETURN COALESCE(result, '[]'::jsonb);
    WHEN 'string' THEN
      IF NOT rewrite_strings THEN RETURN value; END IF;
      SELECT new_id INTO replacement FROM labby_id_map WHERE old_id=value#>>'{}';
      RETURN CASE WHEN replacement IS NULL THEN value ELSE to_jsonb(replacement::text) END;
    ELSE RETURN value;
  END CASE;
END;
$$;

-- Rewrite documents before their relational keys so embedded references remain aligned.
UPDATE persons SET payload=labby_rewrite_ids(payload),keyword_ids=labby_rewrite_ids(keyword_ids,true);
UPDATE keywords SET payload=labby_rewrite_ids(payload);
UPDATE keyword_relations SET metadata=labby_rewrite_ids(metadata);
UPDATE configs SET payload=labby_rewrite_ids(payload);
UPDATE constraints SET payload=labby_rewrite_ids(payload),person_ids=labby_rewrite_ids(person_ids,true);
UPDATE schedules SET payload=labby_rewrite_ids(payload),person_ids=labby_rewrite_ids(person_ids,true);
UPDATE unavailabilities SET payload=labby_rewrite_ids(payload),person_ids=labby_rewrite_ids(person_ids,true);
UPDATE email_tasks SET payload=labby_rewrite_ids(payload);
UPDATE system_settings SET payload=labby_rewrite_ids(payload);
UPDATE users SET payload=labby_rewrite_ids(payload);
UPDATE refresh_tokens SET payload=labby_rewrite_ids(payload);
UPDATE auth_verification_codes SET payload=labby_rewrite_ids(payload);
UPDATE keyword_vectors SET payload=labby_rewrite_ids(payload);
UPDATE ranking_judgments SET payload=labby_rewrite_ids(payload);

DROP TRIGGER keywords_graph_change ON keywords;
DROP TRIGGER vectors_graph_change ON keyword_vectors;
DROP INDEX IF EXISTS keywords_graph_id_idx;
ALTER TABLE keyword_relations DROP CONSTRAINT keyword_relations_source_id_fkey;
ALTER TABLE keyword_relations DROP CONSTRAINT keyword_relations_target_id_fkey;
ALTER TABLE keyword_vectors DROP CONSTRAINT keyword_vectors_keyword_id_fkey;
ALTER TABLE refresh_tokens DROP CONSTRAINT refresh_tokens_user_id_fkey;
ALTER TABLE auth_verification_codes DROP CONSTRAINT auth_verification_codes_user_id_fkey;

ALTER TABLE persons ALTER id TYPE uuid USING labby_uuid(id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE keywords ALTER id TYPE uuid USING labby_uuid(id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE keyword_relations ALTER id TYPE uuid USING labby_uuid(id), ALTER source_id TYPE uuid USING labby_uuid(source_id),
  ALTER target_id TYPE uuid USING labby_uuid(target_id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE configs ALTER id TYPE uuid USING labby_uuid(id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE constraints ALTER id TYPE uuid USING labby_uuid(id), ALTER config_id DROP NOT NULL,
  ALTER config_id TYPE uuid USING CASE WHEN config_id='' THEN NULL ELSE labby_uuid(config_id) END,
  ALTER created_at TYPE timestamptz USING to_timestamp(created_at::double precision/1000),
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000);
ALTER TABLE schedules ALTER id TYPE uuid USING labby_uuid(id), ALTER config_id TYPE uuid USING labby_uuid(config_id),
  ALTER created_at TYPE timestamptz USING to_timestamp(created_at::double precision/1000), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE unavailabilities ALTER id TYPE uuid USING labby_uuid(id), ALTER person_id DROP NOT NULL,
  ALTER person_id TYPE uuid USING CASE WHEN person_id='' THEN NULL ELSE labby_uuid(person_id) END,
  ALTER config_id TYPE uuid USING labby_uuid(config_id);
ALTER TABLE email_tasks ALTER id TYPE uuid USING labby_uuid(id), ALTER config_id TYPE uuid USING labby_uuid(config_id),
  ALTER updated_at DROP DEFAULT, ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE system_settings ALTER id TYPE uuid USING labby_uuid(id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE users ALTER id TYPE uuid USING labby_uuid(id), ALTER created_at TYPE timestamptz USING to_timestamp(created_at::double precision/1000);
ALTER TABLE refresh_tokens ALTER token_id TYPE uuid USING labby_uuid(token_id), ALTER user_id TYPE uuid USING labby_uuid(user_id),
  ALTER expires_at TYPE timestamptz USING to_timestamp(expires_at::double precision/1000),
  ALTER created_at TYPE timestamptz USING to_timestamp(created_at::double precision/1000),
  ALTER revoked_at TYPE timestamptz USING CASE WHEN revoked_at IS NULL THEN NULL ELSE to_timestamp(revoked_at::double precision/1000) END,
  ALTER replaced_by_token_id TYPE uuid USING CASE WHEN replaced_by_token_id IS NULL THEN NULL ELSE labby_uuid(replaced_by_token_id) END;
ALTER TABLE auth_verification_codes ALTER token_id TYPE uuid USING labby_uuid(token_id),
  ALTER user_id TYPE uuid USING CASE WHEN user_id IS NULL THEN NULL ELSE labby_uuid(user_id) END,
  ALTER expires_at TYPE timestamptz USING to_timestamp(expires_at::double precision/1000),
  ALTER created_at TYPE timestamptz USING to_timestamp(created_at::double precision/1000),
  ALTER consumed_at TYPE timestamptz USING CASE WHEN consumed_at IS NULL THEN NULL ELSE to_timestamp(consumed_at::double precision/1000) END;
ALTER TABLE keyword_vectors ALTER keyword_id TYPE uuid USING labby_uuid(keyword_id), ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000);
ALTER TABLE ranking_judgments ALTER id TYPE uuid USING labby_uuid(id);
ALTER TABLE embedding_migration_archive ALTER keyword_id TYPE uuid USING labby_uuid(keyword_id);
ALTER TABLE graph_changes ALTER keyword_id TYPE uuid USING labby_uuid(keyword_id);

ALTER TABLE keyword_relations ADD CONSTRAINT keyword_relations_source_id_fkey FOREIGN KEY(source_id) REFERENCES keywords(id) ON DELETE CASCADE;
ALTER TABLE keyword_relations ADD CONSTRAINT keyword_relations_target_id_fkey FOREIGN KEY(target_id) REFERENCES keywords(id) ON DELETE CASCADE;
ALTER TABLE keyword_vectors ADD CONSTRAINT keyword_vectors_keyword_id_fkey FOREIGN KEY(keyword_id) REFERENCES keywords(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE auth_verification_codes ADD CONSTRAINT auth_verification_codes_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION record_graph_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_id uuid; next_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'keywords' THEN
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.keyword_id ELSE NEW.keyword_id END;
  END IF;
  UPDATE graph_clock SET revision=revision+1 WHERE singleton RETURNING revision INTO next_revision;
  INSERT INTO graph_changes(keyword_id,revision) VALUES(changed_id,next_revision)
  ON CONFLICT(keyword_id) DO UPDATE SET revision=excluded.revision;
  RETURN NULL;
END;
$$;

CREATE TABLE person_tags (
  id uuid PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX person_tags_updated_at_idx ON person_tags(updated_at DESC,id DESC);
CREATE INDEX keywords_graph_id_idx ON keywords(id);

CREATE TRIGGER keywords_graph_change AFTER INSERT OR UPDATE OR DELETE ON keywords FOR EACH ROW EXECUTE FUNCTION record_graph_change();
CREATE TRIGGER vectors_graph_change AFTER INSERT OR UPDATE OR DELETE ON keyword_vectors FOR EACH ROW EXECUTE FUNCTION record_graph_change();
UPDATE graph_clock SET epoch=md5(random()::text||clock_timestamp()::text),revision=revision+1 WHERE singleton;
DROP FUNCTION labby_rewrite_ids(jsonb,boolean);
DROP FUNCTION labby_uuid(text);
