import { SERVER_SCHEMA_VERSION, SCHEMA_NAMES } from './schema-state.js';
import { up as productEmbeddingUp } from './migrate/002.up.js';
import { runSqlFile, type MigrationClient } from './migrate/runtime.js';

const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    up: (client: MigrationClient) => runSqlFile(client, '001.up.sql'),
  },
  {
    version: 2,
    name: 'product-embedding-and-ranking-history',
    up: productEmbeddingUp,
  },
  {
    version: 3,
    name: SCHEMA_NAMES[2],
    up: (client: MigrationClient) => runSqlFile(client, '003.up.sql'),
  },
  {
    version: 4,
    name: SCHEMA_NAMES[3],
    up: (client: MigrationClient) => runSqlFile(client, '004.up.sql'),
  },
  {
    version: 5,
    name: SCHEMA_NAMES[4],
    up: (client: MigrationClient) => runSqlFile(client, '005.up.sql'),
  },
  {
    version: 6,
    name: SCHEMA_NAMES[5],
    up: (client: MigrationClient) => runSqlFile(client, '006.up.sql'),
  },
  {
    version: 7,
    name: SCHEMA_NAMES[6],
    up: (client: MigrationClient) => runSqlFile(client, '007.up.sql'),
  },
] as const;

/** Runs on a dedicated connection, so BEGIN/COMMIT/locks cannot hop pool connections. */
export async function migratePostgresSchema(
  client: MigrationClient,
  postgres = false,
  onProgress?: (message: string) => void,
): Promise<void> {
  await client.query('BEGIN');
  try {
    if (postgres) await client.query('SELECT pg_advisory_xact_lock(192837465)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    const applied = (
      await client.query('SELECT version, name FROM schema_migrations ORDER BY version')
    ).rows;
    for (let i = 0; i < applied.length; i++) {
      if (Number(applied[i]!.version) !== i + 1 || applied[i]!.name !== MIGRATIONS[i]?.name)
        throw new Error('Unknown or inconsistent database migration history');
    }
    let version = applied.length;
    if (version > SERVER_SCHEMA_VERSION)
      throw new Error('Database schema is newer than this application');
    if (version === 0) {
      const existing = (await client.query("SELECT to_regclass('public.persons') AS name")).rows[0]
        ?.name;
      if (!existing) {
        throw new Error('Empty database. Run pnpm --filter @labby/server db:init first.');
      } else {
        // Adopt the pre-migration schema only when its distinguishing vector column exists.
        const column = (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='keyword_vectors' AND column_name='vector64'",
          )
        ).rows;
        if (!column.length) throw new Error('Unrecognized unversioned database schema');
      }
      onProgress?.('Adopting the existing legacy baseline (version 1).');
      await client.query('INSERT INTO schema_migrations(version,name) VALUES(1,$1)', [
        MIGRATIONS[0]!.name,
      ]);
      version = 1;
    }
    for (const migration of MIGRATIONS.slice(version)) {
      onProgress?.(
        'Running migration ' +
          migration.version +
          ': ' +
          migration.name +
          ' (transaction not yet committed).',
      );
      await migration.up(client);
      await client.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)', [
        migration.version,
        migration.name,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    onProgress?.('Migration transaction rolled back; no migration changes were saved.');
    throw error;
  }
}
