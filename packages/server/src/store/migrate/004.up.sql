-- Legacy installations used TEXT for JSON documents. Convert only application
-- columns, preserving their JSON values. Invalid JSON aborts the whole migration.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.table_name, c.column_name, c.column_default
    FROM information_schema.columns c
    JOIN (VALUES
      ('persons', 'payload'), ('persons', 'keyword_ids'),
      ('keywords', 'payload'), ('keyword_relations', 'metadata'),
      ('configs', 'payload'), ('constraints', 'payload'), ('constraints', 'person_ids'),
      ('schedules', 'payload'), ('schedules', 'person_ids'),
      ('unavailabilities', 'payload'), ('unavailabilities', 'person_ids'),
      ('email_tasks', 'payload'), ('system_settings', 'payload'),
      ('users', 'payload'), ('refresh_tokens', 'payload'),
      ('auth_verification_codes', 'payload'), ('keyword_vectors', 'payload'),
      ('keyword_vectors', 'embedding'), ('keyword_vectors', 'geometry'),
      ('ranking_judgments', 'payload')
    ) AS expected(table_name, column_name)
      ON c.table_name = expected.table_name AND c.column_name = expected.column_name
    WHERE c.table_schema = 'public' AND c.data_type <> 'jsonb'
    ORDER BY c.table_name, c.ordinal_position
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', item.table_name, item.column_name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE jsonb USING %I::jsonb',
      item.table_name, item.column_name, item.column_name);
    IF item.column_default IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT (%s)::jsonb',
        item.table_name, item.column_name, item.column_default);
    END IF;
  END LOOP;
END;
$$;

-- Connected clients must reload previously delivered string payloads.
UPDATE graph_clock SET epoch = md5(random()::text || clock_timestamp()::text);
