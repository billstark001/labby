import type { MigrationClient } from './migrate/runtime.js';
import { SCHEMA_NAMES, SCHEMA_VERSION } from '@labby/db';
export { SCHEMA_NAMES } from '@labby/db';
export const SERVER_SCHEMA_VERSION = SCHEMA_VERSION;

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
