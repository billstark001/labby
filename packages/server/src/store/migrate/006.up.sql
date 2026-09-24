ALTER TABLE constraints ADD COLUMN tag_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE constraints SET payload = payload || '{"tagIds":[]}'::jsonb;
UPDATE constraints SET payload = payload - 'weight' WHERE type = 'no-overlap';
CREATE INDEX constraints_person_ids_gin_idx ON constraints USING gin (person_ids);
CREATE INDEX constraints_tag_ids_gin_idx ON constraints USING gin (tag_ids);
