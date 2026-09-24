UPDATE person_tags
SET payload = jsonb_set(payload, '{names}', jsonb_build_object('en', payload->>'name', 'zh', '', 'ja', ''))
WHERE NOT (payload ? 'names');

UPDATE constraints
SET payload = jsonb_set(payload, '{disabled}', 'false'::jsonb)
WHERE NOT (payload ? 'disabled');
