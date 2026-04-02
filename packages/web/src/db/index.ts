/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, similarities, configs, schedules, unavailabilities.
 */

import { IDBPDatabase } from 'idb';
import { DatabaseDump, LabbyDB } from '@labby/core';
import { signal } from '@preact/signals';

import {
  createDB,
  createIDB,
  restoreIDBDatabase,
} from './idb';
import { createApiDB } from './api';
import { createDummyDB } from './dummy';
import { personsSignal, keywordsSignal, similarityEdgesSignal, configsSignal, schedulesSignal, unavailabilitiesSignal } from '@/store';
import { databaseMode } from '@/lib/runtime.js';

const DB_CONFIG = databaseMode;

const isDBAvailable = signal(false);
const db = signal<LabbyDB | null>(null);

let _idb: IDBPDatabase | null = null;

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
    dbInstance.persons.getAll(),
    dbInstance.keywords.getAll(),
    dbInstance.similarities.getAll(),
    dbInstance.configs.getAll(),
    dbInstance.schedules.getAll(),
    dbInstance.unavailabilities.getAll(),
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
    db.persons.getAll(),
    db.keywords.getAll(),
    db.similarities.getAll(),
    db.configs.getAll(),
    db.schedules.getAll(),
    db.unavailabilities.getAll(),
  ]);

  personsSignal.value = persons ?? [];
  keywordsSignal.value = keywords ?? [];
  similarityEdgesSignal.value = similarities ?? [];
  configsSignal.value = configs ?? [];
  schedulesSignal.value = schedules ?? [];
  unavailabilitiesSignal.value = unavailabilities ?? [];
}