ALTER TABLE entities ADD COLUMN all_people boolean NOT NULL DEFAULT false;

UPDATE entities
SET payload = (payload - 'personId') || jsonb_build_object(
  'personIds', CASE
    WHEN jsonb_typeof(payload->'personIds') = 'array' THEN payload->'personIds'
    WHEN payload ? 'personId' AND payload->>'personId' IS NOT NULL THEN jsonb_build_array(payload->>'personId')
    ELSE '[]'::jsonb
  END,
  'tagIds', '[]'::jsonb,
  'allPeople', false
)
WHERE kind = 'unavailability';
