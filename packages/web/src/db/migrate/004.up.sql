CREATE TABLE graph_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0,
  epoch text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text)
);
INSERT INTO graph_clock(singleton) VALUES(true);
-- Retain deletion tombstones; only the latest change per keyword is needed.
CREATE TABLE graph_changes (
  keyword_id text PRIMARY KEY,
  revision bigint NOT NULL UNIQUE
);
CREATE FUNCTION record_graph_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_id text;
  changed_kind text;
  next_revision bigint;
BEGIN
  changed_kind := CASE WHEN TG_OP = 'DELETE' THEN OLD.kind ELSE NEW.kind END;
  IF changed_kind NOT IN ('keyword', 'keyword-vector') THEN RETURN NULL; END IF;
  changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  UPDATE graph_clock SET revision=revision+1 WHERE singleton RETURNING revision INTO next_revision;
  INSERT INTO graph_changes(keyword_id,revision) VALUES(changed_id,next_revision)
  ON CONFLICT(keyword_id) DO UPDATE SET revision=excluded.revision;
  RETURN NULL;
END;
$$;
CREATE TRIGGER entities_graph_change AFTER INSERT OR UPDATE OR DELETE ON entities
FOR EACH ROW EXECUTE FUNCTION record_graph_change();
CREATE INDEX entities_graph_id_idx ON entities(kind, id COLLATE "C");
