/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, keyword vectors, configs, schedules, unavailabilities.
 */

import { IDBPDatabase } from 'idb';
import {
  KeywordForeignKeyBundle,
  PersonForeignKeyBundle,
  ScheduleForeignKeyBundle,
  DatabaseDump,
  LabbyDB,
} from '@labby/core';
import { signal } from '@preact/signals';

import {
  createDB,
  createIDB,
  restoreIDBDatabase,
} from './idb';
import { createApiDB } from './api';
import { createDummyDB } from './dummy';
import { personsSignal, keywordsSignal, keywordVectorsSignal, configsSignal, constraintsSignal, schedulesSignal, unavailabilitiesSignal, emailTasksSignal } from '@/store';
import { databaseMode } from '@/lib/runtime';

const DB_CONFIG = databaseMode;

const isDBAvailable = signal(false);
const db = signal<LabbyDB | null>(null);

let _idb: IDBPDatabase | null = null;
const DEFAULT_PAGE_SIZE = 50;

async function listAllPaginated<T>(
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

async function setSignalFromFirstPage<T>(
  store: { list: (query: { offset: number; limit: number }) => Promise<{ items: T[] }> },
  setter: (items: T[]) => void,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const page = await store.list({ offset: 0, limit: pageSize });
  setter(page.items ?? []);
}

export async function initDB() {
  try {
    if (DB_CONFIG === 'idb') {
      _idb = await createDB();
      db.value = createIDB(_idb);
    } else if (DB_CONFIG === 'api') {
      db.value = createApiDB();
    } else {
      db.value = createDummyDB();
    }
    isDBAvailable.value = true;
  } catch (err) {
    _idb = null;
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
  const [persons, keywords, keywordVectors, configs, constraints, schedules, unavailabilities, emailTasks] = await Promise.all([
    listAllPaginated(dbInstance.persons),
    listAllPaginated(dbInstance.keywords),
    listAllPaginated(dbInstance.keywordVectors),
    listAllPaginated(dbInstance.configs),
    listAllPaginated(dbInstance.constraints),
    listAllPaginated(dbInstance.schedules),
    listAllPaginated(dbInstance.unavailabilities),
    listAllPaginated(dbInstance.emailTasks),
  ]);
  return { persons, keywords, keywordVectors, configs, constraints, schedules, unavailabilities, emailTasks };
}

export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  if (DB_CONFIG === 'idb') {
    if (!_idb) throw new Error('IndexedDB is not initialized');
    await restoreIDBDatabase(_idb, dump);
  } else {
    throw new Error('Restore is only supported for IndexedDB configuration');
  }
}

export async function loadDatabaseSignals(db: LabbyDB) {
  const [persons, keywords, keywordVectors, configs, constraints, schedules, unavailabilities, emailTasks] = await Promise.all([
    listAllPaginated(db.persons),
    listAllPaginated(db.keywords),
    listAllPaginated(db.keywordVectors),
    listAllPaginated(db.configs),
    listAllPaginated(db.constraints),
    listAllPaginated(db.schedules),
    listAllPaginated(db.unavailabilities),
    listAllPaginated(db.emailTasks),
  ]);

  personsSignal.value = persons ?? [];
  keywordsSignal.value = keywords ?? [];
  keywordVectorsSignal.value = keywordVectors ?? [];
  configsSignal.value = configs ?? [];
  constraintsSignal.value = constraints ?? [];
  schedulesSignal.value = schedules ?? [];
  unavailabilitiesSignal.value = unavailabilities ?? [];
  emailTasksSignal.value = emailTasks ?? [];
}

export async function loadPersonsFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.persons, items => {
    personsSignal.value = items;
  }, pageSize);
}

export async function loadKeywordsFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.keywords, items => {
    keywordsSignal.value = items;
  }, pageSize);
}

export async function loadSimilaritiesFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.keywordVectors, items => {
    keywordVectorsSignal.value = items;
  }, pageSize);
}

export async function loadConfigsFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.configs, items => {
    configsSignal.value = items;
  }, pageSize);
}

export async function loadSchedulesFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.schedules, items => {
    schedulesSignal.value = items;
  }, pageSize);
}

export async function loadUnavailabilitiesFirstPage(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  await setSignalFromFirstPage(db.unavailabilities, items => {
    unavailabilitiesSignal.value = items;
  }, pageSize);
}

export async function loadAllPersons(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  personsSignal.value = await listAllPaginated(db.persons, pageSize);
}

export async function loadAllKeywords(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  keywordsSignal.value = await listAllPaginated(db.keywords, pageSize);
}

export async function loadAllSimilarities(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  keywordVectorsSignal.value = await listAllPaginated(db.keywordVectors, pageSize);
}

export async function loadAllConfigs(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  configsSignal.value = await listAllPaginated(db.configs, pageSize);
}

export async function loadAllConstraints(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  constraintsSignal.value = await listAllPaginated(db.constraints, pageSize);
}

export async function loadAllSchedules(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  schedulesSignal.value = await listAllPaginated(db.schedules, pageSize);
}

export async function loadAllUnavailabilities(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  unavailabilitiesSignal.value = await listAllPaginated(db.unavailabilities, pageSize);
}

export async function listPersonsPage(db: LabbyDB, offset: number, limit: number) {
  return db.persons.list({ offset, limit });
}

export async function listKeywordsPage(db: LabbyDB, offset: number, limit: number) {
  return db.keywords.list({ offset, limit });
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

export async function loadAllEmailTasks(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  emailTasksSignal.value = await listAllPaginated(db.emailTasks, pageSize);
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
  const counts = new Map<string, number>();

  for (const schedule of bundle.schedules) {
    for (const session of schedule.sessions) {
      for (const presentation of session.presentations) {
        counts.set(presentation.presenterId, (counts.get(presentation.presenterId) ?? 0) + 1);
        for (const questionerId of presentation.questionerIds) {
          counts.set(questionerId, (counts.get(questionerId) ?? 0) + 1);
        }
      }
    }
  }

  for (const unavailability of bundle.unavailabilities) {
    const personIds = Array.isArray(unavailability.personIds) && unavailability.personIds.length > 0
      ? unavailability.personIds
      : (unavailability.personId ? [unavailability.personId] : []);
    for (const personId of personIds) {
      counts.set(personId, (counts.get(personId) ?? 0) + 1);
    }
  }

  for (const constraint of bundle.constraints) {
    const personIds = Array.isArray((constraint as { personIds?: unknown }).personIds)
      ? ((constraint as { personIds: string[] }).personIds)
      : [];
    for (const personId of personIds) {
      counts.set(personId, (counts.get(personId) ?? 0) + 1);
    }
  }

  return counts;
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