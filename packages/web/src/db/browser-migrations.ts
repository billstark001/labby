import type { PGliteWorker } from '@electric-sql/pglite/worker';
import { migrateEuclideanVector } from './migrate/003-projection.js';

export const BROWSER_SCHEMA_VERSION = 6;

export function pendingBrowserSchemaVersions(currentVersion: number): number[] {
  if (!Number.isInteger(currentVersion) || currentVersion < 0)
    throw new Error('Invalid browser database schema version');
  if (currentVersion > BROWSER_SCHEMA_VERSION)
    throw new Error(
      `Browser database schema ${currentVersion} is newer than supported version ${BROWSER_SCHEMA_VERSION}`,
    );
  return Array.from(
    { length: BROWSER_SCHEMA_VERSION - currentVersion },
    (_, i) => currentVersion + i + 1,
  );
}

export async function upgradeBrowserSchema(
  client: Pick<PGliteWorker, 'transaction'>,
  sql: { current: string; graph: string; identity: string; constraints: string },
  onMaintenance?: (kind: 'initialize' | 'migrate') => void,
): Promise<boolean> {
  let changed = false;
  await client.transaction(async (tx) => {
    const exists = await tx.query<{ name: string | null }>(
      "SELECT to_regclass('public.app_metadata') AS name",
    );
    if (!exists.rows[0]?.name) {
      onMaintenance?.('initialize');
      await tx.exec(sql.current);
      changed = true;
      return;
    }
    const result = await tx.query<{ value: { version: number } }>(
      "SELECT value FROM app_metadata WHERE key='schema-version'",
    );
    const pending = pendingBrowserSchemaVersions(result.rows[0]?.value.version ?? 0);
    if (pending.length) {
      onMaintenance?.('migrate');
      changed = true;
    }
    for (const version of pending) {
      if (version === 5) await tx.exec(sql.identity);
      if (version === 6) await tx.exec(sql.constraints);
      if (version === 4) await tx.exec(sql.graph);
      if (version === 1)
        await tx.exec(
          'CREATE TABLE entities(kind text NOT NULL,id text NOT NULL,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL,PRIMARY KEY(kind,id))',
        );
      if (version === 2)
        await tx.exec(
          'CREATE INDEX entities_kind_updated_idx ON entities(kind,updated_at DESC,id)',
        );
      if (version === 3) {
        await tx.exec(
          'CREATE TABLE embedding_migration_archive(keyword_id text PRIMARY KEY,source jsonb NOT NULL)',
        );
        const vectors = await tx.query<{
          id: string;
          payload: { keywordId: string; vector64: number[]; updatedAt: number };
        }>("SELECT id,payload FROM entities WHERE kind='keyword-vector'");
        for (const row of vectors.rows) {
          await tx.query(
            'INSERT INTO embedding_migration_archive(keyword_id,source) VALUES($1,$2::jsonb)',
            [row.id, JSON.stringify(row.payload)],
          );
          const next = migrateEuclideanVector(row.payload);
          await tx.query(
            "UPDATE entities SET payload=$1::jsonb WHERE kind='keyword-vector' AND id=$2",
            [JSON.stringify(next), row.id],
          );
        }
      }
      await tx.query(
        "INSERT INTO app_metadata(key,value) VALUES('schema-version',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify({ version })],
      );
    }
  });
  return changed;
}
