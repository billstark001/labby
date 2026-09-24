UPDATE entities
SET payload = jsonb_set(payload, '{names}', jsonb_build_object('en', payload->>'name', 'zh', '', 'ja', ''))
WHERE kind = 'person-tag' AND NOT (payload ? 'names');

UPDATE entities
SET payload = jsonb_set(payload, '{disabled}', 'false'::jsonb)
WHERE kind = 'constraint' AND NOT (payload ? 'disabled');
