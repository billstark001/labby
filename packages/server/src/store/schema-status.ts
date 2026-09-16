import type { MigrationClient } from './migrate/runtime.js';
import { SCHEMA_NAMES, SERVER_SCHEMA_VERSION } from './schema-state.js';

export interface SchemaStatus {
  supportedVersion: number;
  state: 'empty' | 'legacy' | 'pending' | 'current' | 'inconsistent';
  applied: Array<{ version: number; name: string }>;
  pendingVersions: number[];
  message: string;
  nextCommand: string | null;
}

/** Read-only inspection distinguishes a legacy database from a genuinely empty database. */
export async function inspectSchema(client: MigrationClient): Promise<SchemaStatus> {
  const tables = (
    await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")
  ).rows.map((row) => String(row.tablename));
  const applied = tables.includes('schema_migrations')
    ? (await client.query('SELECT version,name FROM schema_migrations ORDER BY version')).rows.map(
        (row) => ({ version: Number(row.version), name: String(row.name) }),
      )
    : [];
  const result = (
    state: SchemaStatus['state'],
    message: string,
    nextCommand: string | null,
    from: number,
  ): SchemaStatus => ({
    supportedVersion: SERVER_SCHEMA_VERSION,
    state,
    applied,
    pendingVersions:
      state === 'inconsistent'
        ? []
        : Array.from({ length: SERVER_SCHEMA_VERSION - from }, (_, index) => from + index + 1),
    message,
    nextCommand,
  });
  if (applied.length) {
    if (
      applied.length > SERVER_SCHEMA_VERSION ||
      applied.some((row, index) => row.version !== index + 1 || row.name !== SCHEMA_NAMES[index])
    ) {
      return result(
        'inconsistent',
        'Migration history is newer than or inconsistent with this application. No automatic repair is performed.',
        null,
        0,
      );
    }
    if (applied.length === SERVER_SCHEMA_VERSION)
      return result(
        'current',
        'Database schema is current. No migration is needed.',
        null,
        applied.length,
      );
    return result(
      'pending',
      'Pending migrations have not been applied.',
      'pnpm --filter @labby/server db:migrate',
      applied.length,
    );
  }
  if (tables.length === 0)
    return result(
      'empty',
      'Database has no application schema. Initialize it before running the server.',
      'pnpm --filter @labby/server db:init',
      0,
    );
  const columns = (
    await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='keyword_vectors'",
    )
  ).rows.map((row) => String(row.column_name));
  if (tables.includes('persons') && tables.includes('keywords') && columns.includes('vector64')) {
    return result(
      'legacy',
      'Existing legacy database detected. An empty migration history does NOT mean the database is empty. Migration will adopt baseline version 1, then apply pending versions.',
      'pnpm --filter @labby/server db:migrate',
      1,
    );
  }
  return result(
    'inconsistent',
    'Existing tables have no recognized migration history. Do not run db:init on this database; inspect its schema first.',
    null,
    0,
  );
}
