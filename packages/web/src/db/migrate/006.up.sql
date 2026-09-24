UPDATE entities
SET payload = payload || '{"tagIds":[]}'::jsonb
WHERE kind = 'constraint';
UPDATE entities
SET payload = payload - 'weight'
WHERE kind = 'constraint' AND payload->>'type' = 'no-overlap';
