CREATE FUNCTION labby_uuid(value text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE digest text;
BEGIN
  IF value='system' THEN RETURN '00000000-0000-4000-8000-000000000001'::uuid; END IF;
  IF value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN value::uuid; END IF;
  digest:=md5('labby:v5:'||value);
  RETURN (substr(digest,1,8)||'-'||substr(digest,9,4)||'-5'||substr(digest,14,3)||'-a'||substr(digest,18,3)||'-'||substr(digest,21,12))::uuid;
END;
$$;
CREATE TEMP TABLE labby_id_map(old_id text PRIMARY KEY,new_id uuid NOT NULL UNIQUE) ON COMMIT DROP;
INSERT INTO labby_id_map SELECT id,labby_uuid(id) FROM (SELECT DISTINCT id FROM entities) ids;
CREATE FUNCTION labby_rewrite_ids(value jsonb,rewrite_strings boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb; replacement uuid;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT jsonb_object_agg(key,labby_rewrite_ids(val,rewrite_strings OR key='id' OR key ~ '(Id|Ids)$' OR key='groups')) INTO result FROM jsonb_each(value) entry(key,val); RETURN COALESCE(result,'{}');
    WHEN 'array' THEN SELECT jsonb_agg(labby_rewrite_ids(val,rewrite_strings)) INTO result FROM jsonb_array_elements(value) item(val); RETURN COALESCE(result,'[]');
    WHEN 'string' THEN IF NOT rewrite_strings THEN RETURN value; END IF; SELECT new_id INTO replacement FROM labby_id_map WHERE old_id=value#>>'{}'; RETURN CASE WHEN replacement IS NULL THEN value ELSE to_jsonb(replacement::text) END;
    ELSE RETURN value;
  END CASE;
END;
$$;
UPDATE entities SET payload=labby_rewrite_ids(payload);
DROP TRIGGER entities_graph_change ON entities;
DROP INDEX IF EXISTS entities_graph_id_idx;
ALTER TABLE entities ALTER id TYPE uuid USING labby_uuid(id), ALTER updated_at DROP DEFAULT,
  ALTER updated_at TYPE timestamptz USING to_timestamp(updated_at::double precision/1000), ALTER updated_at SET DEFAULT now();
ALTER TABLE embedding_migration_archive ALTER keyword_id TYPE uuid USING labby_uuid(keyword_id);
ALTER TABLE graph_changes ALTER keyword_id TYPE uuid USING labby_uuid(keyword_id);
CREATE OR REPLACE FUNCTION record_graph_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_id uuid; changed_kind text; next_revision bigint;
BEGIN
  changed_kind:=CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END;
  IF changed_kind NOT IN ('keyword','keyword-vector') THEN RETURN NULL; END IF;
  changed_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  UPDATE graph_clock SET revision=revision+1 WHERE singleton RETURNING revision INTO next_revision;
  INSERT INTO graph_changes(keyword_id,revision) VALUES(changed_id,next_revision)
  ON CONFLICT(keyword_id) DO UPDATE SET revision=excluded.revision;
  RETURN NULL;
END;
$$;
CREATE TRIGGER entities_graph_change AFTER INSERT OR UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION record_graph_change();
CREATE INDEX entities_graph_id_idx ON entities(kind,id);
UPDATE graph_clock SET epoch=md5(random()::text||clock_timestamp()::text),revision=revision+1 WHERE singleton;
DROP FUNCTION labby_rewrite_ids(jsonb,boolean);
DROP FUNCTION labby_uuid(text);
