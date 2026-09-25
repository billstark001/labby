import { SCHEMA_NAMES, SCHEMA_VERSION } from '@labby/db';
import type { PGliteWorker } from '@electric-sql/pglite/worker';

export async function upgradeSharedSchema(
  client: Pick<PGliteWorker, 'query' | 'transaction'>,
  sql: { metadata: string },
  onMigration?: () => void,
): Promise<boolean> {
  const migrations = [{ version: 11, name: SCHEMA_NAMES[10], sql: sql.metadata }] as const;
  const history = (await client.query<{ version: number; name: string }>(
    'SELECT version,name FROM schema_migrations ORDER BY version',
  )).rows;
  if (history.length > SCHEMA_VERSION || history.some((row, index) =>
    Number(row.version) !== index + 1 || row.name !== SCHEMA_NAMES[index]))
    throw new Error('Browser database schema is newer or inconsistent');
  const pending = migrations.filter(migration => migration.version > history.length);
  if (history.length + pending.length !== SCHEMA_VERSION)
    throw new Error('Browser database schema has no supported upgrade path');
  if (!pending.length) return false;
  onMigration?.();
  await client.transaction(async tx => {
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)',
        [migration.version, migration.name]);
    }
  });
  return true;
}
