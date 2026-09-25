import {
  upsertPerson, upsertPersonTag, upsertKeyword, upsertKeywordVector, upsertRankingJudgment,
  upsertConfig, upsertConstraint, upsertSchedule, upsertUnavailability, upsertEmailTask,
  upsertSystemSettings, type BusinessKind, type RecordQueryClient,
} from '@labby/db';
import type {
  Person, PersonTag, Keyword, KeywordVector, RankingJudgment, ScheduleConfig,
  ScheduleConstraint, SchedulePlan, PersonUnavailability, EmailTask, SystemSettings,
} from '@labby/core';
import type { PGliteWorker } from '@electric-sql/pglite/worker';

const insertOrder: BusinessKind[] = [
  'person', 'person-tag', 'keyword', 'config', 'constraint', 'schedule',
  'unavailability', 'email-task', 'system-settings', 'keyword-vector', 'ranking-judgment',
];
const knownKinds = new Set<string>(insertOrder);

export async function writeLegacyRow(client: RecordQueryClient, kind: BusinessKind, id: string, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error(`Invalid browser ${kind} payload`);
  const value: unknown = {
    ...(payload as Record<string, unknown>),
    [kind === 'keyword-vector' ? 'keywordId' : 'id']: id,
  };
  switch (kind) {
    case 'person': return upsertPerson(client, value as Person);
    case 'person-tag': return upsertPersonTag(client, value as PersonTag);
    case 'keyword': return upsertKeyword(client, value as Keyword);
    case 'keyword-vector': return upsertKeywordVector(client, value as KeywordVector);
    case 'ranking-judgment': return upsertRankingJudgment(client, value as RankingJudgment);
    case 'config': return upsertConfig(client, value as ScheduleConfig);
    case 'constraint': return upsertConstraint(client, value as ScheduleConstraint);
    case 'schedule': return upsertSchedule(client, value as SchedulePlan);
    case 'unavailability': return upsertUnavailability(client, value as PersonUnavailability);
    case 'email-task': return upsertEmailTask(client, value as EmailTask);
    case 'system-settings': return upsertSystemSettings(client, value as SystemSettings);
  }
}

/** One-time, transactional conversion of the browser's former document table. */
export async function migrateBrowserToSharedSchema(
  client: Pick<PGliteWorker, 'transaction'>,
  currentSchemaSql: string,
): Promise<void> {
  await client.transaction(async tx => {
    const rows = (await tx.query<{ kind: string; id: string; payload: unknown }>(
      'SELECT kind,id,payload FROM entities ORDER BY kind,id',
    )).rows;
    for (const row of rows)
      if (!knownKinds.has(row.kind)) throw new Error(`Unknown browser entity kind: ${row.kind}`);
    const archives = (await tx.query<{ keyword_id: string; source: unknown }>(
      'SELECT keyword_id,source FROM embedding_migration_archive',
    )).rows;
    const imported = (await tx.query<{ value: unknown }>(
      "SELECT value FROM app_metadata WHERE key='legacy-idb-v6-import'",
    )).rows[0]?.value;

    await tx.exec(`
      DROP TABLE entities;
      DROP TABLE graph_changes;
      DROP TABLE graph_clock;
      DROP FUNCTION record_graph_change();
      DROP TABLE embedding_migration_archive;
      DROP TABLE app_metadata;
    `);
    await tx.exec(currentSchemaSql);
    if (imported !== undefined)
      await tx.query('INSERT INTO app_metadata(key,value) VALUES($1,$2::jsonb)',
        ['legacy-idb-v6-import', JSON.stringify(imported)]);
    for (const kind of insertOrder)
      for (const item of rows.filter(row => row.kind === kind))
        await writeLegacyRow(tx, kind, item.id, item.payload);
    for (const archive of archives)
      await tx.query(
        'INSERT INTO embedding_migration_archive(keyword_id,source) VALUES($1,$2::jsonb)',
        [archive.keyword_id, JSON.stringify(archive.source)],
      );
  });
}
