ALTER TABLE unavailabilities ADD COLUMN tag_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE unavailabilities ADD COLUMN all_people BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE unavailabilities
SET person_ids = CASE
      WHEN jsonb_typeof(payload->'personIds') = 'array' THEN payload->'personIds'
      WHEN payload ? 'personId' AND payload->>'personId' IS NOT NULL THEN jsonb_build_array(payload->>'personId')
      ELSE '[]'::jsonb
    END;

UPDATE unavailabilities
SET payload = (payload - 'personId') || jsonb_build_object(
  'personIds', person_ids, 'tagIds', '[]'::jsonb, 'allPeople', false
);

DROP INDEX IF EXISTS unavailabilities_person_idx;
ALTER TABLE unavailabilities DROP COLUMN person_id;
CREATE INDEX unavailabilities_person_ids_gin_idx ON unavailabilities USING gin (person_ids);
CREATE INDEX unavailabilities_tag_ids_gin_idx ON unavailabilities USING gin (tag_ids);
