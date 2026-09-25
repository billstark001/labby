import { readBusinessRecord, type BusinessKind } from '@labby/db';
import { SYSTEM_SETTINGS_ID, normalizeStoredConstraint } from '@labby/core';
import type { ScheduleConstraint } from '@labby/core';
import type { PGliteWorker } from '@electric-sql/pglite/worker';
import { legacyDumpToEntityRows, type LegacyMigrationDump } from '../legacy-idb-upgrade';
import { writeLegacyRow } from './010-to-shared';

export const LEGACY_IMPORT_KEY = 'legacy-idb-v6-import';

function rewriteEntityIds(value: unknown, idMap: ReadonlyMap<string, string>, rewriteStrings = false): unknown {
  if (typeof value === 'string') return rewriteStrings ? (idMap.get(value) ?? value) : value;
  if (Array.isArray(value)) return value.map(item => rewriteEntityIds(item, idMap, rewriteStrings));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, rewriteEntityIds(item, idMap, rewriteStrings || key === 'id' || key === 'groups' || /(Id|Ids)$/.test(key)),
    ]));
  return value;
}

async function normalizeUuid(value: string): Promise<string> {
  if (value === 'system') return SYSTEM_SETTINGS_ID;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`labby:browser:v5:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

export async function importLegacyIndexedDbDump(
  client: Pick<PGliteWorker, 'transaction'>,
  dump: LegacyMigrationDump | null,
): Promise<void> {
  const rawRows = dump ? legacyDumpToEntityRows(dump) : [];
  const idMap = new Map<string, string>();
  for (const row of rawRows) idMap.set(row.id, await normalizeUuid(row.id));
  const rows = rawRows.map(row => {
    const payload = rewriteEntityIds(row.payload, idMap);
    return { kind: row.kind as BusinessKind, id: idMap.get(row.id)!,
      payload: row.kind === 'constraint' ? normalizeStoredConstraint(payload as ScheduleConstraint) : payload };
  });

  await client.transaction(async tx => {
    const migrated = await tx.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key=$1) AS exists', [LEGACY_IMPORT_KEY],
    );
    if (migrated.rows[0]?.exists) return;
    for (const row of rows)
      if (!await readBusinessRecord(tx, row.kind, row.id))
        await writeLegacyRow(tx, row.kind, row.id, row.payload);
    for (const row of dump?.embeddingMigrationArchive ?? [])
      await tx.query(
        'INSERT INTO embedding_migration_archive(keyword_id,source) VALUES($1,$2::jsonb) ON CONFLICT(keyword_id) DO NOTHING',
        [idMap.get(row.keywordId) ?? await normalizeUuid(row.keywordId), JSON.stringify(row.source)],
      );
    await tx.query('INSERT INTO app_metadata(key,value) VALUES($1,$2::jsonb)',
      [LEGACY_IMPORT_KEY, JSON.stringify({ importedAt: Date.now(), records: rows.length })]);
  });
}
