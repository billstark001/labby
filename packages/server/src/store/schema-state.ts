import type { MigrationClient } from './migrate/runtime.js';
export const SERVER_SCHEMA_VERSION = 9;
export const SCHEMA_NAMES = [
  'baseline',
  'product-embedding-and-ranking-history',
  'graph-change-feed',
  'jsonb-documents',
  'uuid-timestamptz-person-tags',
  'constraint-tag-targets',
  'localized-person-tags-and-constraint-state',
  'unavailability-selectors-and-closures',
  'scheduler-dispatch-deduplication',
] as const;

export async function checkPostgresSchema(client: MigrationClient): Promise<void> {
  const table = (await client.query("SELECT to_regclass('public.schema_migrations') AS name"))
    .rows[0]?.name;
  if (!table) {
    const existing = (await client.query("SELECT to_regclass('public.persons') AS name")).rows[0]
      ?.name;
    const command = existing ? 'db:migrate' : 'db:init';
    throw new Error(
      'Database schema requires setup. Run pnpm --filter @labby/server ' +
        command +
        ' (using configured environment or explicit connection options).',
    );
  }
  const { rows } = await client.query(
    'SELECT version,name FROM schema_migrations ORDER BY version',
  );
  if (
    rows.length !== SERVER_SCHEMA_VERSION ||
    rows.some((row, index) => Number(row.version) !== index + 1 || row.name !== SCHEMA_NAMES[index])
  ) {
    throw new Error(
      'Database schema does not match this server. Run pnpm --filter @labby/server db:migrate using configured environment or explicit connection options (or use a matching server for a newer schema).',
    );
  }
}
