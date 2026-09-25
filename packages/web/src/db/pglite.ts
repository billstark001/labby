import currentSchemaSql from '@labby/db/current-schema.sql?raw';
import sharedMetadataSql from '@labby/db/migrate/011.up.sql?raw';
import legacySchemaSql from './migrate/legacy-current-schema.sql?raw';
import graphMigrationSql from './migrate/004.up.sql?raw';
import identityMigrationSql from './migrate/005.up.sql?raw';
import constraintMigrationSql from './migrate/006.up.sql?raw';
import localizationMigrationSql from './migrate/007.up.sql?raw';
import unavailabilityMigrationSql from './migrate/008.up.sql?raw';
import pairGroupsMigrationSql from './migrate/009.up.sql?raw';
import {
  buildEntityPageQueries, clearBusinessRecords, deleteBusinessRecord, listGraphPage,
  readAllBusinessRecords, readBusinessRecord, upsertPerson, upsertPersonTag,
  upsertKeyword, upsertKeywordVector, upsertRankingJudgment, upsertConfig,
  upsertConstraint, upsertSchedule, upsertUnavailability, upsertEmailTask,
  upsertSystemSettings,
  type BusinessKind,
} from '@labby/db';
import { toast } from '@/components/ui/Toast';
import { i18n } from '@/i18n';
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
  validateScheduleAssignments,
  validateUnavailability,
  ProductEmbeddingEngine,
  constraintSelectorIds,
} from '@labby/core';
import { upgradeBrowserSchema } from './browser-migrations';
import { upgradeSharedSchema } from './shared-migrations';
import { migrateBrowserToSharedSchema } from './migrate/010-to-shared';
import { readLegacyIndexedDbDump } from './legacy-idb-upgrade';
import { importLegacyIndexedDbDump, LEGACY_IMPORT_KEY } from './migrate/legacy-idb-import';

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
type EntityKind = BusinessKind;

const SYSTEM_ID = SYSTEM_SETTINGS_ID;

function normalizedQuery(
  query: ListQuery,
): Required<Pick<ListQuery, 'offset' | 'limit'>> & ListQuery {
  return {
    ...query,
    offset: Math.max(0, Math.floor(query.offset)),
    limit: Math.max(1, Math.floor(query.limit)),
  };
}

function localizedName(record: Record<string, unknown>, locale: ListQuery['locale']): string {
  const names = record.names as Record<string, string> | undefined;
  const language = locale === 'zh-CN' ? 'zh' : locale === 'ja-JP' ? 'ja' : 'en';
  return names?.[language]?.trim() || names?.en?.trim() || String(record.name ?? '').trim();
}

function compareEntities(left: StoredEntity, right: StoredEntity, query: ListQuery): number {
  const sortBy = query.sortBy ?? 'modifiedAt';
  const direction = query.sortDirection ?? (sortBy === 'modifiedAt' ? 'desc' : 'asc');
  const factor = direction === 'asc' ? 1 : -1;
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const collator = new Intl.Collator(query.locale ?? 'en', { sensitivity: 'base', numeric: true });
  const compareText = (a: unknown, b: unknown) => collator.compare(String(a ?? '').trim(), String(b ?? '').trim());
  let primary: number;
  if (sortBy === 'tags' || sortBy === 'keywords') primary = 0;
  else if (sortBy === 'disabled') primary = (Number(Boolean(leftRecord.disabled)) - Number(Boolean(rightRecord.disabled))) * factor;
  else if (sortBy === 'modifiedAt') primary = (Number(leftRecord.modifiedAt ?? 0) - Number(rightRecord.modifiedAt ?? 0)) * factor;
  else primary = compareText(sortBy === 'name' ? localizedName(leftRecord, query.locale) : leftRecord[sortBy], sortBy === 'name' ? localizedName(rightRecord, query.locale) : rightRecord[sortBy]) * factor;
  if (primary !== 0) return primary;
  const byDate = Number(rightRecord.modifiedAt ?? 0) - Number(leftRecord.modifiedAt ?? 0);
  if (byDate) return byDate;
  const byName = compareText(localizedName(leftRecord, query.locale), localizedName(rightRecord, query.locale));
  if (byName) return byName;
  const byNotes = compareText(leftRecord.notes, rightRecord.notes);
  if (byNotes) return byNotes;
  return compareText(leftRecord.id ?? leftRecord.keywordId, rightRecord.id ?? rightRecord.keywordId);
}

function hasOverlap(left: readonly string[], right: Set<string>): boolean {
  return left.some((value) => right.has(value));
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
    const schemaState = (await client.query<{ canonical: string | null; legacy: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS canonical, to_regclass('public.entities') AS legacy",
    )).rows[0]!;
    let changed = false;
    if (schemaState.legacy) {
      if (schemaState.canonical) throw new Error('Browser database contains conflicting schemas');
      await upgradeBrowserSchema(
        client,
        { current: legacySchemaSql, graph: graphMigrationSql, identity: identityMigrationSql, constraints: constraintMigrationSql, localization: localizationMigrationSql, unavailability: unavailabilityMigrationSql, pairGroups: pairGroupsMigrationSql },
        () => { maintenanceToast = toast.loading(i18n.t('dbMigrating')); },
      );
      await migrateBrowserToSharedSchema(client, currentSchemaSql);
      changed = true;
    } else if (!schemaState.canonical) {
      maintenanceToast = toast.loading(i18n.t('dbInitializing'));
      await client.transaction(tx => tx.exec(currentSchemaSql));
      changed = true;
    }
    changed = await upgradeSharedSchema(client, { metadata: sharedMetadataSql }, () => {
      if (maintenanceToast === undefined) maintenanceToast = toast.loading(i18n.t('dbMigrating'));
    }) || changed;
    const imported = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key=$1) AS exists',
      [LEGACY_IMPORT_KEY],
    );
    if (!imported.rows[0]?.exists) {
      if (maintenanceToast === undefined) maintenanceToast = toast.loading(i18n.t('dbMigrating'));
      const legacyDump = await readLegacyIndexedDbDump();
      await importLegacyIndexedDbDump(client, legacyDump);
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
    return readAllBusinessRecords<T>(client, kind);
  }

  async function get<T extends StoredEntity>(kind: EntityKind, id: string): Promise<T | undefined> {
    return readBusinessRecord<T>(client, kind, id);
  }

  async function putSchedule(schedule: SchedulePlan): Promise<void> {
    const config = await get<ScheduleConfig>('config', schedule.configId);
    if (!config) throw new Error('Schedule config not found');
    const [persons, unavailabilities, constraints] = await Promise.all([
      all<Person>('person'), all<PersonUnavailability>('unavailability'), all<ScheduleConstraint>('constraint'),
    ]);
    const violations = validateScheduleAssignments(schedule.sessions, {
      config, persons, unavailabilities, constraints: constraints.filter(item => item.configId === config.id),
      similarities: { getPairSimilarity: () => undefined },
    });
    if (violations.length) throw new Error(violations[0]);
    await upsertSchedule(client, schedule);
  }

  async function remove(kind: EntityKind, id: string): Promise<void> {
    await client.transaction(async (tx) => {
      if (kind === 'keyword' || kind === 'keyword-vector') {
        await tx.query(
          "DELETE FROM ranking_judgments WHERE payload->>'anchorId'=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'groups') g,jsonb_array_elements_text(g) candidate WHERE candidate=$1)",
          [id],
        );
        if (kind === 'keyword')
          await deleteBusinessRecord(tx, 'keyword-vector', id);
      }
      await deleteBusinessRecord(tx, kind, id);
    });
  }

  async function clear(kind: EntityKind): Promise<void> {
    await client.transaction(async (tx) => {
      if (kind === 'keyword' || kind === 'keyword-vector')
        await tx.exec('DELETE FROM ranking_judgments; DELETE FROM keyword_vectors;');
      await clearBusinessRecords(tx, kind);
    });
  }

  async function list<T extends StoredEntity>(
    kind: EntityKind,
    query: ListQuery,
  ): Promise<PaginatedResult<T>> {
    const normalized = normalizedQuery(query);
    if (kind === 'person' || kind === 'person-tag' || kind === 'keyword') {
      const table = kind === 'person' ? 'persons' : kind === 'person-tag' ? 'person_tags' : 'keywords';
      const { pageSql, countSql, offset, limit } = buildEntityPageQueries(table, normalized, '"C"');
      const [page, count] = await Promise.all([
        client.query<{ payload: T }>(pageSql),
        client.query<{ total: number }>(countSql),
      ]);
      return { items: page.rows.map(row => row.payload), total: Number(count.rows[0]?.total ?? 0), offset, limit };
    }
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
            await upsertKeywordVector(tx, v);
          await tx.query('DELETE FROM ranking_judgments');
          for (const j of history)
            await upsertRankingJudgment(tx, j);
        });
      },
    },
    persons: {
      get: (id) => get<Person>('person', id),
      list: (query) => list<Person>('person', query),
      put: (value) => upsertPerson(client, value),
      delete: (id) => remove('person', id),
      clear: () => clear('person'),
    },
    personTags: {
      get: (id) => get<PersonTag>('person-tag', id),
      list: (query) => list<PersonTag>('person-tag', query),
      put: (value) => upsertPersonTag(client, value),
      delete: async (id) => {
        const referenced = await client.query<{ id: string }>(
          'SELECT id FROM constraints WHERE tag_ids ? $1 UNION ALL SELECT id FROM unavailabilities WHERE tag_ids ? $1 LIMIT 1',
          [id],
        );
        if (referenced.rows.length) throw new Error('Tag is referenced by a scheduling rule');
        const persons = await all<Person>('person');
        await client.transaction(async (tx) => {
          for (const person of persons.filter(item => item.tagIds?.includes(id))) {
            const next = { ...person, tagIds: person.tagIds!.filter(tagId => tagId !== id), modifiedAt: Date.now() };
            await upsertPerson(tx, next);
          }
          await deleteBusinessRecord(tx, 'person-tag', id);
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
      put: (value) => upsertKeyword(client, value),
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
        return upsertKeywordVector(client, value);
      },
      putMany: async (values) => {
        for (const value of values) {
          validateKeywordVector(value);
          await upsertKeywordVector(client, value);
        }
      },
      delete: (id) => remove('keyword-vector', id),
      clear: () => clear('keyword-vector'),
    },
    configs: {
      get: (id) => get<ScheduleConfig>('config', id),
      list: (query) => list<ScheduleConfig>('config', query),
      put: (value) => upsertConfig(client, value),
      delete: (id) => remove('config', id),
      clear: () => clear('config'),
    },
    constraints: {
      get: (id) => get<ScheduleConstraint>('constraint', id),
      list: (query) => list<ScheduleConstraint>('constraint', query),
      put: (value) => upsertConstraint(client, value),
      delete: (id) => remove('constraint', id),
      clear: () => clear('constraint'),
    },
    schedules: {
      get: (id) => get<SchedulePlan>('schedule', id),
      list: (query) => list<SchedulePlan>('schedule', query),
      put: putSchedule,
      delete: (id) => remove('schedule', id),
      clear: () => clear('schedule'),
    },
    unavailabilities: {
      get: (id) => get<PersonUnavailability>('unavailability', id),
      list: (query) => list<PersonUnavailability>('unavailability', query),
      put: (value) => {
        const errors = validateUnavailability(value);
        if (errors.length) throw new Error(errors[0]);
        return upsertUnavailability(client, {
        ...value,
        personIds: value.allPeople ? [] : [...new Set(value.personIds)],
        tagIds: value.allPeople ? [] : [...new Set(value.tagIds)],
        });
      },
      delete: (id) => remove('unavailability', id),
      clear: () => clear('unavailability'),
    },
    emailTasks: {
      get: (id) => get<EmailTask>('email-task', id),
      list: (query) => list<EmailTask>('email-task', query),
      put: (value) => upsertEmailTask(client, value),
      delete: (id) => remove('email-task', id),
      clear: () => clear('email-task'),
    },
    systemSettings: {
      get: async () =>
        (await get<SystemSettings>('system-settings', SYSTEM_ID)) ?? { id: SYSTEM_ID },
      put: (value) =>
        upsertSystemSettings(client, {
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
        const referencedTagIds = new Set(selectedConstraints.flatMap(constraint => constraintSelectorIds(constraint).tagIds));
        selectedUnavailabilities.forEach(item => item.tagIds.forEach(id => referencedTagIds.add(id)));
        selectedConstraints.forEach((constraint) => {
          constraintSelectorIds(constraint).personIds
            .forEach(id => personIds.add(id));
        });
        persons.filter(person => person.tagIds?.some(tagId => referencedTagIds.has(tagId)))
          .forEach(person => personIds.add(person.id));
        selectedUnavailabilities.forEach((item) =>
          item.personIds.forEach((id) => personIds.add(id)),
        );
        const selectedPersons = persons.filter((item) => personIds.has(item.id));
        const keywordIds = new Set(selectedPersons.flatMap((item) => item.keywordIds));
        return {
          configs: configs.filter((item) => wantedConfigs.has(item.id)),
          constraints: selectedConstraints,
          schedules: selectedSchedules,
          unavailabilities: selectedUnavailabilities,
          persons: selectedPersons,
          personTags: personTags.filter(tag => referencedTagIds.has(tag.id) || selectedPersons.some(person => person.tagIds?.includes(tag.id))),
          keywords: keywords.filter((item) => keywordIds.has(item.id)),
          keywordVectors: keywordVectors.filter((item) => keywordIds.has(item.keywordId)),
        };
      },
      readForPerson: async ({ personIds }) => {
        const wanted = new Set(personIds);
        const [persons, constraints, schedules, unavailabilities] = await Promise.all([
          all<Person>('person'),
          all<ScheduleConstraint>('constraint'),
          all<SchedulePlan>('schedule'),
          all<PersonUnavailability>('unavailability'),
        ]);
        const constraintSelectors = constraints.map(constraintSelectorIds);
        const referencedPersonIds = persons.filter(person => wanted.has(person.id) && (
          schedules.some(schedule => schedule.sessions.some(session => session.presentations.some(presentation =>
            presentation.presenterId === person.id || presentation.questionerIds.includes(person.id))))
          || unavailabilities.some(item => item.personIds.includes(person.id)
            || item.tagIds.some(tagId => person.tagIds?.includes(tagId)))
          || constraintSelectors.some(selectors => {
            return selectors.personIds.includes(person.id)
              || selectors.tagIds.some(tagId => person.tagIds?.includes(tagId));
          })
        )).map(person => person.id).sort();
        return { referencedPersonIds };
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
    graph: { list: (query = {}) => listGraphPage(client, query) },
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
    await client.transaction(async (tx) => {
      await tx.exec(`
        DELETE FROM ranking_judgments;
        DELETE FROM keyword_vectors;
        DELETE FROM keyword_relations;
        DELETE FROM keywords;
        DELETE FROM system_settings;
        DELETE FROM email_tasks;
        DELETE FROM unavailabilities;
        DELETE FROM schedules;
        DELETE FROM constraints;
        DELETE FROM configs;
        DELETE FROM person_tags;
        DELETE FROM persons;
      `);
      for (const value of dump.persons) await upsertPerson(tx, value);
      for (const value of dump.personTags) await upsertPersonTag(tx, value);
      for (const value of dump.keywords) await upsertKeyword(tx, value);
      for (const value of dump.configs) await upsertConfig(tx, value);
      for (const value of dump.constraints) await upsertConstraint(tx, value);
      for (const value of dump.schedules) await upsertSchedule(tx, value);
      for (const value of dump.unavailabilities) await upsertUnavailability(tx, value);
      for (const value of dump.emailTasks) await upsertEmailTask(tx, value);
      if (dump.systemSettings) await upsertSystemSettings(tx, dump.systemSettings);
      for (const value of dump.keywordVectors) await upsertKeywordVector(tx, value);
      for (const value of dump.rankingHistory) await upsertRankingJudgment(tx, value);
    });
  }

  return { db, restore, close: () => client.close() };
}
