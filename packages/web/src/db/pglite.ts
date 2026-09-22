import currentSchemaSql from './current-schema.sql?raw';
import graphMigrationSql from './migrate/004.up.sql?raw';
import identityMigrationSql from './migrate/005.up.sql?raw';
import { listBrowserGraphPage } from './graph';
import { toast } from '@/components/ui/Toast';
import { i18n } from '@/i18n';
import type { LegacyMigrationDump } from './legacy-idb-upgrade.js';
import { PGliteWorker } from '@electric-sql/pglite/worker';
import type {
  DatabaseDump,
  EmailTask,
  Keyword,
  KeywordVector,
  RankingJudgment,
  LabbyDB,
  ListQuery,
  PaginatedResult,
  Person,
  PersonTag,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
  SystemSettings,
} from '@labby/core';
import {
  SYSTEM_SETTINGS_ID,
  validateKeywordVector,
  validateRankingJudgment,
  ProductEmbeddingEngine,
} from '@labby/core';
import { upgradeBrowserSchema } from './browser-migrations';
import { legacyDumpToEntityRows, readLegacyIndexedDbDump } from './legacy-idb-upgrade';

type StoredEntity =
  | RankingJudgment
  | Person
  | PersonTag
  | Keyword
  | KeywordVector
  | ScheduleConfig
  | ScheduleConstraint
  | SchedulePlan
  | PersonUnavailability
  | EmailTask
  | SystemSettings;
type EntityKind =
  | 'ranking-judgment'
  | 'person'
  | 'person-tag'
  | 'keyword'
  | 'keyword-vector'
  | 'config'
  | 'constraint'
  | 'schedule'
  | 'unavailability'
  | 'email-task'
  | 'system-settings';

const SYSTEM_ID = SYSTEM_SETTINGS_ID;
const LEGACY_MIGRATION_KEY = 'legacy-idb-v6-import';

type SqlClient = Pick<PGliteWorker, 'exec' | 'query' | 'transaction'>;

function rewriteEntityIds(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
  rewriteStrings = false,
): unknown {
  if (typeof value === 'string')
    return rewriteStrings ? (idMap.get(value) ?? value) : value;
  if (Array.isArray(value))
    return value.map(item => rewriteEntityIds(item, idMap, rewriteStrings));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      rewriteEntityIds(
        item,
        idMap,
        rewriteStrings || key === 'id' || key === 'groups' || /(Id|Ids)$/.test(key),
      ),
    ]));
  return value;
}

async function importLegacyDump(
  client: SqlClient,
  dump: LegacyMigrationDump | null,
): Promise<void> {
  const rawRows = dump ? legacyDumpToEntityRows(dump) : [];
  const idMap = new Map<string, string>();
  for (const row of rawRows) idMap.set(row.id, await normalizeUuid(row.id));
  const rows = rawRows.map(row => ({ ...row, id: idMap.get(row.id)!, updated_at: new Date(row.updated_at).toISOString(), payload: rewriteEntityIds(row.payload, idMap) }));

  await client.transaction(async (tx) => {
    const migrated = await tx.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key = $1) AS exists',
      [LEGACY_MIGRATION_KEY],
    );
    if (migrated.rows[0]?.exists) return;

    if (rows.length > 0) {
      await tx.query(
        `INSERT INTO entities(kind, id, updated_at, payload)
         SELECT kind, id, updated_at, payload
         FROM jsonb_to_recordset($1::jsonb)
           AS imported(kind text, id uuid, updated_at timestamptz, payload jsonb)
         ON CONFLICT(kind, id) DO NOTHING`,
        [JSON.stringify(rows)],
      );
    }
    for (const row of dump?.embeddingMigrationArchive ?? [])
      await tx.query(
        'INSERT INTO embedding_migration_archive(keyword_id,source) VALUES($1,$2::jsonb) ON CONFLICT(keyword_id) DO NOTHING',
        [idMap.get(row.keywordId) ?? await normalizeUuid(row.keywordId), JSON.stringify(row.source)],
      );
    await tx.query(
      `INSERT INTO app_metadata(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [LEGACY_MIGRATION_KEY, JSON.stringify({ importedAt: Date.now(), records: rows.length })],
    );
  });
}

async function normalizeUuid(value: string): Promise<string> {
  if (value === 'system') return SYSTEM_SETTINGS_ID;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`labby:browser:v5:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function normalizedQuery(
  query: ListQuery,
): Required<Pick<ListQuery, 'offset' | 'limit'>> & ListQuery {
  return {
    ...query,
    offset: Math.max(0, Math.floor(query.offset)),
    limit: Math.max(1, Math.floor(query.limit)),
  };
}

function compareEntities(left: StoredEntity, right: StoredEntity, query: ListQuery): number {
  const sortBy = query.sortBy ?? 'modifiedAt';
  const direction = query.sortDirection ?? (sortBy === 'modifiedAt' ? 'desc' : 'asc');
  const factor = direction === 'asc' ? 1 : -1;
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftValue = leftRecord[sortBy];
  const rightValue = rightRecord[sortBy];
  const primary =
    typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
  if (primary !== 0) return primary * factor;
  return String(leftRecord.id ?? leftRecord.keywordId ?? '').localeCompare(
    String(rightRecord.id ?? rightRecord.keywordId ?? ''),
  );
}

function hasOverlap(left: readonly string[], right: Set<string>): boolean {
  return left.some((value) => right.has(value));
}

function unavailabilityPersonIds(value: PersonUnavailability): string[] {
  return value.personIds?.length ? value.personIds : value.personId ? [value.personId] : [];
}

export async function createPGliteDB(): Promise<{
  db: LabbyDB;
  restore: (dump: DatabaseDump) => Promise<void>;
  close: () => Promise<void>;
}> {
  const client = await PGliteWorker.create(
    new Worker(new URL('./pglite.worker.ts', import.meta.url), { type: 'module' }),
    { dataDir: 'idb://labby' },
  );
  let maintenanceToast: number | undefined;
  try {
    const changed = await upgradeBrowserSchema(
      client,
      { current: currentSchemaSql, graph: graphMigrationSql, identity: identityMigrationSql },
      (kind) => {
        maintenanceToast = toast.loading(
          i18n.t(kind === 'initialize' ? 'dbInitializing' : 'dbMigrating'),
        );
      },
    );
    const imported = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key=$1) AS exists',
      [LEGACY_MIGRATION_KEY],
    );
    if (!imported.rows[0]?.exists) {
      if (maintenanceToast === undefined) maintenanceToast = toast.loading(i18n.t('dbMigrating'));
      const legacyDump = await readLegacyIndexedDbDump();
      await importLegacyDump(client, legacyDump);
    }
    if (maintenanceToast !== undefined) toast.dismiss(maintenanceToast);
    if (changed || maintenanceToast !== undefined) toast.success(i18n.t('dbMaintenanceComplete'));
  } catch (error) {
    if (maintenanceToast !== undefined) toast.dismiss(maintenanceToast);
    toast.error(i18n.t('dbMaintenanceFailed') + ': ' + String(error), 0);
    await client.close();
    throw error;
  }

  async function all<T extends StoredEntity>(kind: EntityKind): Promise<T[]> {
    const result = await client.query<{ payload: T }>(
      'SELECT payload FROM entities WHERE kind = $1',
      [kind],
    );
    return result.rows.map((row) => row.payload);
  }

  async function get<T extends StoredEntity>(kind: EntityKind, id: string): Promise<T | undefined> {
    const result = await client.query<{ payload: T }>(
      'SELECT payload FROM entities WHERE kind = $1 AND id = $2',
      [kind, id],
    );
    return result.rows[0]?.payload;
  }

  async function put(kind: EntityKind, id: string, value: StoredEntity): Promise<void> {
    const record = value as unknown as Record<string, unknown>;
    const updatedAt = Number(
      record.updatedAt ?? record.modifiedAt ?? record.createdAt ?? Date.now(),
    );
    await client.query(
      `INSERT INTO entities(kind, id, updated_at, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`,
      [kind, id, new Date(updatedAt), JSON.stringify(value)],
    );
  }

  async function remove(kind: EntityKind, id: string): Promise<void> {
    await client.transaction(async (tx) => {
      if (kind === 'keyword' || kind === 'keyword-vector') {
        await tx.query(
          "DELETE FROM entities WHERE kind='ranking-judgment' AND (payload->>'anchorId'=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'groups') g,jsonb_array_elements_text(g) candidate WHERE candidate=$1))",
          [id],
        );
        if (kind === 'keyword')
          await tx.query("DELETE FROM entities WHERE kind='keyword-vector' AND id=$1", [id]);
      }
      await tx.query('DELETE FROM entities WHERE kind=$1 AND id=$2', [kind, id]);
    });
  }

  async function clear(kind: EntityKind): Promise<void> {
    await client.transaction(async (tx) => {
      if (kind === 'keyword' || kind === 'keyword-vector')
        await tx.query("DELETE FROM entities WHERE kind IN ('keyword-vector','ranking-judgment')");
      await tx.query('DELETE FROM entities WHERE kind=$1', [kind]);
    });
  }

  async function list<T extends StoredEntity>(
    kind: EntityKind,
    query: ListQuery,
  ): Promise<PaginatedResult<T>> {
    const normalized = normalizedQuery(query);
    const values = (await all<T>(kind)).sort((left, right) =>
      compareEntities(left, right, normalized),
    );
    return {
      items: values.slice(normalized.offset, normalized.offset + normalized.limit),
      total: values.length,
      offset: normalized.offset,
      limit: normalized.limit,
    };
  }

  const db: LabbyDB = {
    similarity: {
      getHistory: () => all<RankingJudgment>('ranking-judgment'),
      forgetJudgment: async (id) => {
        const work = () => remove('ranking-judgment', id);
        if (typeof navigator !== 'undefined' && navigator.locks)
          await navigator.locks.request('labby-similarity', work);
        else await work();
      },
      commit: async (vectors, history) => {
        for (const v of vectors) validateKeywordVector(v);
        const ids = new Set((await all<Keyword>('keyword')).map((k) => k.id));
        for (const j of history) validateRankingJudgment(j, ids);
        await client.transaction(async (tx) => {
          for (const v of vectors)
            await tx.query(
              "INSERT INTO entities(kind,id,updated_at,payload) VALUES('keyword-vector',$1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
              [v.keywordId, new Date(v.updatedAt), JSON.stringify(v)],
            );
          await tx.query("DELETE FROM entities WHERE kind='ranking-judgment'");
          for (const j of history)
            await tx.query(
              "INSERT INTO entities(kind,id,updated_at,payload) VALUES('ranking-judgment',$1,$2,$3::jsonb)",
              [j.id, new Date(j.createdAt), JSON.stringify(j)],
            );
        });
      },
    },
    persons: {
      get: (id) => get<Person>('person', id),
      list: (query) => list<Person>('person', query),
      put: (value) => put('person', value.id, value),
      delete: (id) => remove('person', id),
      clear: () => clear('person'),
    },
    personTags: {
      get: (id) => get<PersonTag>('person-tag', id),
      list: (query) => list<PersonTag>('person-tag', query),
      put: (value) => put('person-tag', value.id, value),
      delete: async (id) => {
        const persons = await all<Person>('person');
        await client.transaction(async (tx) => {
          for (const person of persons.filter(item => item.tagIds?.includes(id))) {
            const next = { ...person, tagIds: person.tagIds!.filter(tagId => tagId !== id), modifiedAt: Date.now() };
            await tx.query("UPDATE entities SET updated_at=$1,payload=$2::jsonb WHERE kind='person' AND id=$3", [new Date(next.modifiedAt), JSON.stringify(next), next.id]);
          }
          await tx.query("DELETE FROM entities WHERE kind='person-tag' AND id=$1", [id]);
        });
      },
      clear: async () => {
        const tags = await all<PersonTag>('person-tag');
        for (const tag of tags) await db.personTags.delete(tag.id);
      },
    },
    keywords: {
      get: (id) => get<Keyword>('keyword', id),
      list: (query) => list<Keyword>('keyword', query),
      put: (value) => put('keyword', value.id, value),
      delete: (id) => remove('keyword', id),
      clear: () => clear('keyword'),
    },
    keywordVectors: {
      get: (id) => get<KeywordVector>('keyword-vector', id),
      getMany: async (ids) =>
        (await Promise.all(ids.map((id) => get<KeywordVector>('keyword-vector', id)))).filter(
          (value): value is KeywordVector => Boolean(value),
        ),
      list: (query) => list<KeywordVector>('keyword-vector', query),
      put: (value) => {
        validateKeywordVector(value);
        return put('keyword-vector', value.keywordId, value);
      },
      putMany: async (values) => {
        for (const value of values) {
          validateKeywordVector(value);
          await put('keyword-vector', value.keywordId, value);
        }
      },
      delete: (id) => remove('keyword-vector', id),
      clear: () => clear('keyword-vector'),
    },
    configs: {
      get: (id) => get<ScheduleConfig>('config', id),
      list: (query) => list<ScheduleConfig>('config', query),
      put: (value) => put('config', value.id, value),
      delete: (id) => remove('config', id),
      clear: () => clear('config'),
    },
    constraints: {
      get: (id) => get<ScheduleConstraint>('constraint', id),
      list: (query) => list<ScheduleConstraint>('constraint', query),
      put: (value) => put('constraint', value.id, value),
      delete: (id) => remove('constraint', id),
      clear: () => clear('constraint'),
    },
    schedules: {
      get: (id) => get<SchedulePlan>('schedule', id),
      list: (query) => list<SchedulePlan>('schedule', query),
      put: (value) => put('schedule', value.id, value),
      delete: (id) => remove('schedule', id),
      clear: () => clear('schedule'),
    },
    unavailabilities: {
      get: (id) => get<PersonUnavailability>('unavailability', id),
      list: (query) => list<PersonUnavailability>('unavailability', query),
      put: (value) =>
        put('unavailability', value.id, { ...value, personIds: unavailabilityPersonIds(value) }),
      delete: (id) => remove('unavailability', id),
      clear: () => clear('unavailability'),
    },
    emailTasks: {
      get: (id) => get<EmailTask>('email-task', id),
      list: (query) => list<EmailTask>('email-task', query),
      put: (value) => put('email-task', value.id, value),
      delete: (id) => remove('email-task', id),
      clear: () => clear('email-task'),
    },
    systemSettings: {
      get: async () =>
        (await get<SystemSettings>('system-settings', SYSTEM_ID)) ?? { id: SYSTEM_ID },
      put: (value) =>
        put('system-settings', SYSTEM_ID, {
          ...value,
          id: SYSTEM_ID,
          modifiedAt: value.modifiedAt ?? Date.now(),
        }),
    },
    foreignKeys: {
      readForSchedule: async ({ configIds }) => {
        const wantedConfigs = new Set(configIds);
        const [
          configs,
          constraints,
          schedules,
          unavailabilities,
          persons,
          keywords,
          keywordVectors,
          personTags,
        ] = await Promise.all([
          all<ScheduleConfig>('config'),
          all<ScheduleConstraint>('constraint'),
          all<SchedulePlan>('schedule'),
          all<PersonUnavailability>('unavailability'),
          all<Person>('person'),
          all<Keyword>('keyword'),
          all<KeywordVector>('keyword-vector'),
          all<PersonTag>('person-tag'),
        ]);
        const selectedSchedules = schedules.filter((item) => wantedConfigs.has(item.configId));
        const selectedConstraints = constraints.filter(
          (item) => !item.configId || wantedConfigs.has(item.configId),
        );
        const selectedUnavailabilities = unavailabilities.filter((item) =>
          wantedConfigs.has(item.configId),
        );
        const personIds = new Set<string>();
        selectedSchedules.forEach((schedule) =>
          schedule.sessions.forEach((session) =>
            session.presentations.forEach((presentation) => {
              personIds.add(presentation.presenterId);
              presentation.questionerIds.forEach((id) => personIds.add(id));
            }),
          ),
        );
        selectedConstraints.forEach((constraint) =>
          (constraint.personIds ?? []).forEach((id) => personIds.add(id)),
        );
        selectedUnavailabilities.forEach((item) =>
          unavailabilityPersonIds(item).forEach((id) => personIds.add(id)),
        );
        const selectedPersons = persons.filter((item) => personIds.has(item.id));
        const keywordIds = new Set(selectedPersons.flatMap((item) => item.keywordIds));
        return {
          configs: configs.filter((item) => wantedConfigs.has(item.id)),
          constraints: selectedConstraints,
          schedules: selectedSchedules,
          unavailabilities: selectedUnavailabilities,
          persons: selectedPersons,
          personTags: personTags.filter(tag => selectedPersons.some(person => person.tagIds?.includes(tag.id))),
          keywords: keywords.filter((item) => keywordIds.has(item.id)),
          keywordVectors: keywordVectors.filter((item) => keywordIds.has(item.keywordId)),
        };
      },
      readForPerson: async ({ personIds }) => {
        const wanted = new Set(personIds);
        const [persons, keywords, personTags, constraints, schedules, unavailabilities] = await Promise.all([
          all<Person>('person'),
          all<Keyword>('keyword'),
          all<PersonTag>('person-tag'),
          all<ScheduleConstraint>('constraint'),
          all<SchedulePlan>('schedule'),
          all<PersonUnavailability>('unavailability'),
        ]);
        const keywordIds = new Set(
          persons.filter((item) => wanted.has(item.id)).flatMap((item) => item.keywordIds),
        );
        return {
          keywords: keywords.filter((item) => keywordIds.has(item.id)),
          personTags: personTags.filter(tag => persons.some(person => wanted.has(person.id) && person.tagIds?.includes(tag.id))),
          constraints: constraints.filter((item) => hasOverlap(item.personIds ?? [], wanted)),
          schedules: schedules.filter((item) =>
            item.sessions.some((session) =>
              session.presentations.some(
                (presentation) =>
                  wanted.has(presentation.presenterId) ||
                  hasOverlap(presentation.questionerIds, wanted),
              ),
            ),
          ),
          unavailabilities: unavailabilities.filter((item) =>
            hasOverlap(unavailabilityPersonIds(item), wanted),
          ),
        };
      },
      readForKeyword: async ({ keywordIds }) => {
        const wanted = new Set(keywordIds);
        const [persons, keywords, keywordVectors] = await Promise.all([
          all<Person>('person'),
          all<Keyword>('keyword'),
          all<KeywordVector>('keyword-vector'),
        ]);
        return {
          persons: persons.filter((item) => hasOverlap(item.keywordIds, wanted)),
          keywords: keywords.filter((item) => wanted.has(item.id)),
          keywordVectors: keywordVectors.filter((item) => wanted.has(item.keywordId)),
        };
      },
    },
    graph: { list: (query = {}) => listBrowserGraphPage(client, query) },
  };

  async function restore(dump: DatabaseDump): Promise<void> {
    const keywordIds = new Set(dump.keywords.map((k) => k.id));
    for (const v of dump.keywordVectors) {
      validateKeywordVector(v);
      if (!keywordIds.has(v.keywordId)) throw new Error('Unknown keyword in dump');
    }
    for (const j of dump.rankingHistory)
      validateRankingJudgment(j, new Set(dump.keywordVectors.map((v) => v.keywordId)));
    new ProductEmbeddingEngine(dump.keywordVectors, dump.rankingHistory);
    const rawRows = [
      ...legacyDumpToEntityRows(dump),
      ...(dump.personTags ?? []).map((tag) => ({
        kind: 'person-tag',
        id: tag.id,
        updated_at: tag.modifiedAt ?? 0,
        payload: tag,
      })),
      ...dump.rankingHistory.map((j) => ({
        kind: 'ranking-judgment',
        id: j.id,
        updated_at: j.createdAt,
        payload: j,
      })),
    ];
    const restoreIdMap = new Map<string, string>();
    for (const row of rawRows) restoreIdMap.set(row.id, await normalizeUuid(row.id));
    const rows = rawRows.map(row => ({ ...row, id: restoreIdMap.get(row.id)!, payload: rewriteEntityIds(row.payload, restoreIdMap) }));
    await client.transaction(async (tx) => {
      await tx.query('DELETE FROM entities');
      for (const row of rows)
        await tx.query(
          'INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
          [row.kind, row.id, new Date(row.updated_at), JSON.stringify(row.payload)],
        );
    });
  }

  return { db, restore, close: () => client.close() };
}
