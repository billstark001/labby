/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, similarities, configs, schedules, unavailabilities.
 */

import { IDBPDatabase } from 'idb';
import {
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
import { personsSignal, keywordsSignal, similarityEdgesSignal, configsSignal, schedulesSignal, unavailabilitiesSignal } from '@/store';
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
  const [persons, keywords, similarities, configs, schedules, unavailabilities] = await Promise.all([
    listAllPaginated(dbInstance.persons),
    listAllPaginated(dbInstance.keywords),
    listAllPaginated(dbInstance.similarities),
    listAllPaginated(dbInstance.configs),
    listAllPaginated(dbInstance.schedules),
    listAllPaginated(dbInstance.unavailabilities),
  ]);
  return { persons, keywords, similarities, configs, schedules, unavailabilities };
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
  const [persons, keywords, similarities, configs, schedules, unavailabilities] = await Promise.all([
    listAllPaginated(db.persons),
    listAllPaginated(db.keywords),
    listAllPaginated(db.similarities),
    listAllPaginated(db.configs),
    listAllPaginated(db.schedules),
    listAllPaginated(db.unavailabilities),
  ]);

  personsSignal.value = persons ?? [];
  keywordsSignal.value = keywords ?? [];
  similarityEdgesSignal.value = similarities ?? [];
  configsSignal.value = configs ?? [];
  schedulesSignal.value = schedules ?? [];
  unavailabilitiesSignal.value = unavailabilities ?? [];
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
  await setSignalFromFirstPage(db.similarities, items => {
    similarityEdgesSignal.value = items;
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
  similarityEdgesSignal.value = await listAllPaginated(db.similarities, pageSize);
}

export async function loadAllConfigs(db: LabbyDB, pageSize = DEFAULT_PAGE_SIZE) {
  configsSignal.value = await listAllPaginated(db.configs, pageSize);
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
  return db.similarities.list({ offset, limit });
}

export async function listConfigsPage(db: LabbyDB, offset: number, limit: number) {
  return db.configs.list({ offset, limit });
}

export async function listSchedulesPage(db: LabbyDB, offset: number, limit: number) {
  return db.schedules.list({ offset, limit });
}

export async function listUnavailabilitiesPage(db: LabbyDB, offset: number, limit: number) {
  return db.unavailabilities.list({ offset, limit });
}