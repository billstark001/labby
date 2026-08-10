import { PGliteWorker } from '@electric-sql/pglite/worker';
import type {
  DatabaseDump, EmailTask, Keyword, KeywordVector, LabbyDB, ListQuery, PaginatedResult, Person,
  PersonUnavailability, ScheduleConfig, ScheduleConstraint, SchedulePlan, SystemSettings,
} from '@labby/core';
import { buildSimilarityGraphEdges } from '@labby/core';
import { legacyDumpToEntityRows, readLegacyIndexedDbDump } from './legacy-idb-upgrade';

type StoredEntity = Person | Keyword | KeywordVector | ScheduleConfig | ScheduleConstraint | SchedulePlan | PersonUnavailability | EmailTask | SystemSettings;
type EntityKind = 'person' | 'keyword' | 'keyword-vector' | 'config' | 'constraint' | 'schedule' | 'unavailability' | 'email-task' | 'system-settings';

const SYSTEM_ID = 'system';
const BROWSER_SCHEMA_VERSION = 2;
const LEGACY_MIGRATION_KEY = 'legacy-idb-v6-import';

type SqlClient = Pick<PGliteWorker, 'exec' | 'query'>;

const schemaMigrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS entities (
        kind text NOT NULL,
        id text NOT NULL,
        updated_at bigint NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        PRIMARY KEY (kind, id)
      );
    `,
  },
  {
    version: 2,
    sql: 'CREATE INDEX IF NOT EXISTS entities_kind_updated_idx ON entities(kind, updated_at DESC, id);',
  },
] as const;

export function pendingBrowserSchemaVersions(currentVersion: number): number[] {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error('Invalid browser database schema version');
  if (currentVersion > BROWSER_SCHEMA_VERSION) throw new Error(`Browser database schema ${currentVersion} is newer than supported version ${BROWSER_SCHEMA_VERSION}`);
  return schemaMigrations.filter(migration => migration.version > currentVersion).map(migration => migration.version);
}

async function upgradeBrowserSchema(client: SqlClient): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    );
  `);
  const result = await client.query<{ value: { version?: number } }>(
    "SELECT value FROM app_metadata WHERE key = 'schema-version'",
  );
  const currentVersion = Number(result.rows[0]?.value?.version ?? 0);
  const pending = pendingBrowserSchemaVersions(currentVersion);
  for (const version of pending) {
    const migration = schemaMigrations.find(candidate => candidate.version === version)!;
    await client.exec('BEGIN');
    try {
      await client.exec(migration.sql);
      await client.query(
        `INSERT INTO app_metadata(key, value) VALUES ('schema-version', $1::jsonb)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [JSON.stringify({ version })],
      );
      await client.exec('COMMIT');
    } catch (error) {
      await client.exec('ROLLBACK');
      throw error;
    }
  }
}

async function importLegacyDump(client: SqlClient, dump: DatabaseDump | null): Promise<void> {
  if (!dump) return;
  const migrated = await client.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key = $1) AS exists',
    [LEGACY_MIGRATION_KEY],
  );
  if (migrated.rows[0]?.exists) return;
  const rows = legacyDumpToEntityRows(dump);

  await client.exec('BEGIN');
  try {
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO entities(kind, id, updated_at, payload)
         SELECT kind, id, updated_at, payload
         FROM jsonb_to_recordset($1::jsonb)
           AS imported(kind text, id text, updated_at bigint, payload jsonb)
         ON CONFLICT(kind, id) DO NOTHING`,
        [JSON.stringify(rows)],
      );
    }
    await client.query(
      `INSERT INTO app_metadata(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [LEGACY_MIGRATION_KEY, JSON.stringify({ importedAt: Date.now(), records: rows.length })],
    );
    await client.exec('COMMIT');
  } catch (error) {
    await client.exec('ROLLBACK');
    throw error;
  }
}

function normalizedQuery(query: ListQuery): Required<Pick<ListQuery, 'offset' | 'limit'>> & ListQuery {
  return { ...query, offset: Math.max(0, Math.floor(query.offset)), limit: Math.max(1, Math.floor(query.limit)) };
}

function compareEntities(left: StoredEntity, right: StoredEntity, query: ListQuery): number {
  const sortBy = query.sortBy ?? 'modifiedAt';
  const direction = query.sortDirection ?? (sortBy === 'modifiedAt' ? 'desc' : 'asc');
  const factor = direction === 'asc' ? 1 : -1;
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftValue = leftRecord[sortBy];
  const rightValue = rightRecord[sortBy];
  const primary = typeof leftValue === 'number' && typeof rightValue === 'number'
    ? leftValue - rightValue
    : String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
  if (primary !== 0) return primary * factor;
  return String(leftRecord.id ?? leftRecord.keywordId ?? '').localeCompare(String(rightRecord.id ?? rightRecord.keywordId ?? ''));
}

function hasOverlap(left: readonly string[], right: Set<string>): boolean {
  return left.some((value) => right.has(value));
}

function unavailabilityPersonIds(value: PersonUnavailability): string[] {
  return value.personIds?.length ? value.personIds : value.personId ? [value.personId] : [];
}

export async function createPGliteDB(): Promise<{ db: LabbyDB; restore: (dump: DatabaseDump) => Promise<void>; close: () => Promise<void> }> {
  const legacyDump = await readLegacyIndexedDbDump();
  const client = await PGliteWorker.create(
    new Worker(new URL('./pglite.worker.ts', import.meta.url), { type: 'module' }),
    { dataDir: 'idb://labby' },
  );
  try {
    await upgradeBrowserSchema(client);
    await importLegacyDump(client, legacyDump);
  } catch (error) {
    await client.close();
    throw error;
  }

  async function all<T extends StoredEntity>(kind: EntityKind): Promise<T[]> {
    const result = await client.query<{ payload: T }>('SELECT payload FROM entities WHERE kind = $1', [kind]);
    return result.rows.map((row) => row.payload);
  }

  async function get<T extends StoredEntity>(kind: EntityKind, id: string): Promise<T | undefined> {
    const result = await client.query<{ payload: T }>('SELECT payload FROM entities WHERE kind = $1 AND id = $2', [kind, id]);
    return result.rows[0]?.payload;
  }

  async function put(kind: EntityKind, id: string, value: StoredEntity): Promise<void> {
    const record = value as unknown as Record<string, unknown>;
    const updatedAt = Number(record.updatedAt ?? record.modifiedAt ?? record.createdAt ?? Date.now());
    await client.query(
      `INSERT INTO entities(kind, id, updated_at, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload`,
      [kind, id, updatedAt, JSON.stringify(value)],
    );
  }

  async function remove(kind: EntityKind, id: string): Promise<void> {
    await client.query('DELETE FROM entities WHERE kind = $1 AND id = $2', [kind, id]);
  }

  async function clear(kind: EntityKind): Promise<void> {
    await client.query('DELETE FROM entities WHERE kind = $1', [kind]);
  }

  async function list<T extends StoredEntity>(kind: EntityKind, query: ListQuery): Promise<PaginatedResult<T>> {
    const normalized = normalizedQuery(query);
    const values = (await all<T>(kind)).sort((left, right) => compareEntities(left, right, normalized));
    return {
      items: values.slice(normalized.offset, normalized.offset + normalized.limit),
      total: values.length,
      offset: normalized.offset,
      limit: normalized.limit,
    };
  }

  const db: LabbyDB = {
    persons: {
      get: (id) => get<Person>('person', id), list: (query) => list<Person>('person', query),
      put: (value) => put('person', value.id, value), delete: (id) => remove('person', id), clear: () => clear('person'),
    },
    keywords: {
      get: (id) => get<Keyword>('keyword', id), list: (query) => list<Keyword>('keyword', query),
      put: (value) => put('keyword', value.id, value), delete: (id) => remove('keyword', id), clear: () => clear('keyword'),
    },
    keywordVectors: {
      get: (id) => get<KeywordVector>('keyword-vector', id),
      getMany: async (ids) => (await Promise.all(ids.map((id) => get<KeywordVector>('keyword-vector', id)))).filter((value): value is KeywordVector => Boolean(value)),
      list: (query) => list<KeywordVector>('keyword-vector', query),
      put: (value) => put('keyword-vector', value.keywordId, value),
      putMany: async (values) => { for (const value of values) await put('keyword-vector', value.keywordId, value); },
      delete: (id) => remove('keyword-vector', id), clear: () => clear('keyword-vector'),
    },
    configs: {
      get: (id) => get<ScheduleConfig>('config', id), list: (query) => list<ScheduleConfig>('config', query),
      put: (value) => put('config', value.id, value), delete: (id) => remove('config', id), clear: () => clear('config'),
    },
    constraints: {
      get: (id) => get<ScheduleConstraint>('constraint', id), list: (query) => list<ScheduleConstraint>('constraint', query),
      put: (value) => put('constraint', value.id, value), delete: (id) => remove('constraint', id), clear: () => clear('constraint'),
    },
    schedules: {
      get: (id) => get<SchedulePlan>('schedule', id), list: (query) => list<SchedulePlan>('schedule', query),
      put: (value) => put('schedule', value.id, value), delete: (id) => remove('schedule', id), clear: () => clear('schedule'),
    },
    unavailabilities: {
      get: (id) => get<PersonUnavailability>('unavailability', id), list: (query) => list<PersonUnavailability>('unavailability', query),
      put: (value) => put('unavailability', value.id, { ...value, personIds: unavailabilityPersonIds(value) }),
      delete: (id) => remove('unavailability', id), clear: () => clear('unavailability'),
    },
    emailTasks: {
      get: (id) => get<EmailTask>('email-task', id), list: (query) => list<EmailTask>('email-task', query),
      put: (value) => put('email-task', value.id, value), delete: (id) => remove('email-task', id), clear: () => clear('email-task'),
    },
    systemSettings: {
      get: async () => await get<SystemSettings>('system-settings', SYSTEM_ID) ?? { id: SYSTEM_ID },
      put: (value) => put('system-settings', SYSTEM_ID, { ...value, id: SYSTEM_ID, modifiedAt: value.modifiedAt ?? Date.now() }),
    },
    foreignKeys: {
      readForSchedule: async ({ configIds }) => {
        const wantedConfigs = new Set(configIds);
        const [configs, constraints, schedules, unavailabilities, persons, keywords, keywordVectors] = await Promise.all([
          all<ScheduleConfig>('config'), all<ScheduleConstraint>('constraint'), all<SchedulePlan>('schedule'),
          all<PersonUnavailability>('unavailability'), all<Person>('person'), all<Keyword>('keyword'), all<KeywordVector>('keyword-vector'),
        ]);
        const selectedSchedules = schedules.filter((item) => wantedConfigs.has(item.configId));
        const selectedConstraints = constraints.filter((item) => !item.configId || wantedConfigs.has(item.configId));
        const selectedUnavailabilities = unavailabilities.filter((item) => wantedConfigs.has(item.configId));
        const personIds = new Set<string>();
        selectedSchedules.forEach((schedule) => schedule.sessions.forEach((session) => session.presentations.forEach((presentation) => {
          personIds.add(presentation.presenterId); presentation.questionerIds.forEach((id) => personIds.add(id));
        })));
        selectedConstraints.forEach((constraint) => (constraint.personIds ?? []).forEach((id) => personIds.add(id)));
        selectedUnavailabilities.forEach((item) => unavailabilityPersonIds(item).forEach((id) => personIds.add(id)));
        const selectedPersons = persons.filter((item) => personIds.has(item.id));
        const keywordIds = new Set(selectedPersons.flatMap((item) => item.keywordIds));
        return {
          configs: configs.filter((item) => wantedConfigs.has(item.id)), constraints: selectedConstraints,
          schedules: selectedSchedules, unavailabilities: selectedUnavailabilities, persons: selectedPersons,
          keywords: keywords.filter((item) => keywordIds.has(item.id)), keywordVectors: keywordVectors.filter((item) => keywordIds.has(item.keywordId)),
        };
      },
      readForPerson: async ({ personIds }) => {
        const wanted = new Set(personIds);
        const [persons, keywords, constraints, schedules, unavailabilities] = await Promise.all([
          all<Person>('person'), all<Keyword>('keyword'), all<ScheduleConstraint>('constraint'), all<SchedulePlan>('schedule'), all<PersonUnavailability>('unavailability'),
        ]);
        const keywordIds = new Set(persons.filter((item) => wanted.has(item.id)).flatMap((item) => item.keywordIds));
        return {
          keywords: keywords.filter((item) => keywordIds.has(item.id)),
          constraints: constraints.filter((item) => hasOverlap(item.personIds ?? [], wanted)),
          schedules: schedules.filter((item) => item.sessions.some((session) => session.presentations.some((presentation) => wanted.has(presentation.presenterId) || hasOverlap(presentation.questionerIds, wanted)))),
          unavailabilities: unavailabilities.filter((item) => hasOverlap(unavailabilityPersonIds(item), wanted)),
        };
      },
      readForKeyword: async ({ keywordIds }) => {
        const wanted = new Set(keywordIds);
        const [persons, keywords, keywordVectors] = await Promise.all([all<Person>('person'), all<Keyword>('keyword'), all<KeywordVector>('keyword-vector')]);
        return {
          persons: persons.filter((item) => hasOverlap(item.keywordIds, wanted)),
          keywords: keywords.filter((item) => wanted.has(item.id)),
          keywordVectors: keywordVectors.filter((item) => wanted.has(item.keywordId)),
        };
      },
    },
    graph: {
      getSnapshot: async () => {
        const [keywords, keywordVectors] = await Promise.all([all<Keyword>('keyword'), all<KeywordVector>('keyword-vector')]);
        const latestKeyword = keywords.reduce((latest, item) => Math.max(latest, item.modifiedAt ?? 0), 0);
        const latestVector = keywordVectors.reduce((latest, item) => Math.max(latest, item.updatedAt), 0);
        return {
          revision: `${keywords.length}:${keywordVectors.length}:${latestKeyword}:${latestVector}`,
          keywords,
          keywordVectors,
          edges: buildSimilarityGraphEdges(keywordVectors),
        };
      },
    },
  };

  async function restore(dump: DatabaseDump): Promise<void> {
    await client.query('DELETE FROM entities');
    for (const value of dump.persons) await db.persons.put(value);
    for (const value of dump.keywords) await db.keywords.put(value);
    await db.keywordVectors.putMany(dump.keywordVectors);
    for (const value of dump.configs) await db.configs.put(value);
    for (const value of dump.constraints) await db.constraints.put(value);
    for (const value of dump.schedules) await db.schedules.put(value);
    for (const value of dump.unavailabilities) await db.unavailabilities.put(value);
    for (const value of dump.emailTasks) await db.emailTasks.put(value);
    if (dump.systemSettings) await db.systemSettings.put(dump.systemSettings);
  }

  return { db, restore, close: () => client.close() };
}
