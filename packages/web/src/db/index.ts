/**
 * Database facade for browser-local PGlite, server API, or dummy mode.
 */

import {
  KeywordForeignKeyBundle,
  ListQuery,
  PersonForeignKeyBundle,
  ScheduleForeignKeyBundle,
  DatabaseDump,
  LabbyDB,
} from '@labby/core';
import { batch, signal } from '@preact/signals';

import { createPGliteDB } from './pglite';
import { createApiDB } from './api';
import { createDummyDB } from './dummy';
import { personsSignal, personTagsSignal, keywordsSignal, keywordVectorsSignal, configsSignal, constraintsSignal, schedulesSignal, unavailabilitiesSignal } from '@/store';
import { databaseMode } from '@/lib/runtime';

const DB_CONFIG = databaseMode;

const isDBAvailable = signal(false);
const db = signal<LabbyDB | null>(null);

let restorePGlite: ((dump: DatabaseDump) => Promise<void>) | null = null;
const DEFAULT_PAGE_SIZE = 50;

export async function readAllPaginated<T>(
  store: { list: (query: { offset: number; limit: number }) => Promise<{ items: T[]; total: number }> },
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const first = await store.list({ offset: 0, limit: pageSize });
  const all = [...first.items];
  let offset = first.items.length;
  while (offset < first.total) {
    const page = await store.list({ offset, limit: pageSize });
    all.push(...page.items);
    if (page.items.length === 0) break;
    offset += page.items.length;
  }
  return all;
}

export async function initDB() {
  try {
    if (DB_CONFIG === 'pglite') {
      const local = await createPGliteDB();
      db.value = local.db;
      restorePGlite = local.restore;
    } else if (DB_CONFIG === 'api') {
      db.value = createApiDB();
    } else {
      db.value = createDummyDB();
    }
    isDBAvailable.value = true;
  } catch (err) {
    restorePGlite = null;
    isDBAvailable.value = false;
    db.value = null;
    throw err;
  }
  return db.value!;
}

export function useDatabase() {
  if (!isDBAvailable.value || !db.value) {
    throw new Error('Database is not available');
  }
  return db.value;
}

export async function dumpDatabase(): Promise<DatabaseDump> {
  const dbInstance = db.value;
  if (!dbInstance) throw new Error('Database is not initialized');
  const [persons, personTags, keywords, keywordVectors, configs, constraints, schedules, unavailabilities, emailTasks, systemSettings, rankingHistory] = await Promise.all([
    readAllPaginated(dbInstance.persons),
    readAllPaginated(dbInstance.personTags),
    readAllPaginated(dbInstance.keywords),
    readAllPaginated(dbInstance.keywordVectors),
    readAllPaginated(dbInstance.configs),
    readAllPaginated(dbInstance.constraints),
    readAllPaginated(dbInstance.schedules),
    readAllPaginated(dbInstance.unavailabilities),
    readAllPaginated(dbInstance.emailTasks),
    dbInstance.systemSettings.get(),
    dbInstance.similarity.getHistory(),
  ]);
  return { persons, personTags, keywords, keywordVectors, configs, constraints, schedules, unavailabilities, emailTasks, systemSettings, rankingHistory };
}

export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  if (DB_CONFIG === 'pglite') {
    if (!restorePGlite) throw new Error('PGlite is not initialized');
    await restorePGlite(dump);
  } else {
    throw new Error('Restore is only supported for PGlite configuration');
  }
}

export async function loadDatabaseSignals(db: LabbyDB) {
  const [persons, personTags, keywords, keywordVectors, configs, constraints, schedules, unavailabilities] = await Promise.all([
    readAllPaginated(db.persons),
    readAllPaginated(db.personTags),
    readAllPaginated(db.keywords),
    readAllPaginated(db.keywordVectors),
    readAllPaginated(db.configs),
    readAllPaginated(db.constraints),
    readAllPaginated(db.schedules),
    readAllPaginated(db.unavailabilities),
  ]);

  batch(() => {
    personsSignal.value = persons;
    personTagsSignal.value = personTags;
    keywordsSignal.value = keywords;
    keywordVectorsSignal.value = keywordVectors;
    configsSignal.value = configs;
    constraintsSignal.value = constraints;
    schedulesSignal.value = schedules;
    unavailabilitiesSignal.value = unavailabilities;
  });
}

export async function listPersonsPage(db: LabbyDB, query: ListQuery) {
  return db.persons.list(query);
}

export async function listKeywordsPage(db: LabbyDB, query: ListQuery) {
  return db.keywords.list(query);
}

export async function listSimilaritiesPage(db: LabbyDB, offset: number, limit: number) {
  return db.keywordVectors.list({ offset, limit });
}

export async function listConfigsPage(db: LabbyDB, offset: number, limit: number) {
  return db.configs.list({ offset, limit });
}

export async function listConstraintsPage(db: LabbyDB, offset: number, limit: number) {
  return db.constraints.list({ offset, limit });
}

export async function listSchedulesPage(db: LabbyDB, offset: number, limit: number) {
  return db.schedules.list({ offset, limit });
}

export async function listUnavailabilitiesPage(db: LabbyDB, offset: number, limit: number) {
  return db.unavailabilities.list({ offset, limit });
}

export async function listEmailTasksPage(db: LabbyDB, offset: number, limit: number) {
  return db.emailTasks.list({ offset, limit });
}

export async function readScheduleForeignKeys(db: LabbyDB, configIds: string[]): Promise<ScheduleForeignKeyBundle> {
  return db.foreignKeys.readForSchedule({ configIds });
}

export async function readPersonForeignKeys(db: LabbyDB, personIds: string[]): Promise<PersonForeignKeyBundle> {
  return db.foreignKeys.readForPerson({ personIds });
}

export async function readKeywordForeignKeys(db: LabbyDB, keywordIds: string[]): Promise<KeywordForeignKeyBundle> {
  return db.foreignKeys.readForKeyword({ keywordIds });
}

export function buildPersonReferenceCount(bundle: PersonForeignKeyBundle): Map<string, number> {
  return new Map(bundle.referencedPersonIds.map(id => [id, 1]));
}

export function buildKeywordReferenceCount(bundle: KeywordForeignKeyBundle): Map<string, number> {
  const counts = new Map<string, number>();

  for (const person of bundle.persons) {
    for (const keywordId of person.keywordIds) {
      counts.set(keywordId, (counts.get(keywordId) ?? 0) + 1);
    }
  }

  for (const vector of bundle.keywordVectors) {
    counts.set(vector.keywordId, (counts.get(vector.keywordId) ?? 0) + 1);
  }

  return counts;
}
