/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, similarities, configs, schedules.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Person, Keyword, SimilarityEdge, ScheduleConfig, SchedulePlan } from '@labby/core';

const DB_NAME = 'labby';
const DB_VERSION = 1;

export interface LabbyDB {
  persons: Person;
  keywords: Keyword;
  similarities: SimilarityEdge;
  configs: ScheduleConfig;
  schedules: SchedulePlan;
}

let _db: IDBPDatabase | null = null;

export async function getDB(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('persons')) {
        db.createObjectStore('persons', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('keywords')) {
        db.createObjectStore('keywords', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('similarities')) {
        // Compound key [sourceId, targetId]
        db.createObjectStore('similarities', { keyPath: ['sourceId', 'targetId'] });
      }
      if (!db.objectStoreNames.contains('configs')) {
        db.createObjectStore('configs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('schedules')) {
        const schedStore = db.createObjectStore('schedules', { keyPath: 'id' });
        schedStore.createIndex('createdAt', 'createdAt');
      }
    },
  });
  return _db;
}

// ---------------------------------------------------------------------------
// Generic CRUD helpers
// ---------------------------------------------------------------------------

async function getAll<T>(store: string): Promise<T[]> {
  const db = await getDB();
  return db.getAll(store) as Promise<T[]>;
}

async function put<T>(store: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put(store, value);
}

async function del(store: string, key: IDBValidKey): Promise<void> {
  const db = await getDB();
  await db.delete(store, key);
}

async function clear(store: string): Promise<void> {
  const db = await getDB();
  await db.clear(store);
}

// ---------------------------------------------------------------------------
// Domain-specific helpers
// ---------------------------------------------------------------------------

export const db = {
  persons: {
    getAll: () => getAll<Person>('persons'),
    put: (p: Person) => put('persons', p),
    delete: (id: string) => del('persons', id),
  },
  keywords: {
    getAll: () => getAll<Keyword>('keywords'),
    put: (k: Keyword) => put('keywords', k),
    delete: (id: string) => del('keywords', id),
  },
  similarities: {
    getAll: () => getAll<SimilarityEdge>('similarities'),
    put: (e: SimilarityEdge) => put('similarities', e),
    delete: (sourceId: string, targetId: string) =>
      del('similarities', [sourceId, targetId]),
    clear: () => clear('similarities'),
  },
  configs: {
    getAll: () => getAll<ScheduleConfig>('configs'),
    put: (c: ScheduleConfig) => put('configs', c),
    delete: (id: string) => del('configs', id),
  },
  schedules: {
    getAll: () => getAll<SchedulePlan>('schedules'),
    put: (s: SchedulePlan) => put('schedules', s),
    delete: (id: string) => del('schedules', id),
  },
};

// ---------------------------------------------------------------------------
// Bulk backup / restore
// ---------------------------------------------------------------------------

export interface DatabaseDump {
  persons: Person[];
  keywords: Keyword[];
  similarities: SimilarityEdge[];
  configs: ScheduleConfig[];
  schedules: SchedulePlan[];
}

export async function dumpDatabase(): Promise<DatabaseDump> {
  const [persons, keywords, similarities, configs, schedules] = await Promise.all([
    db.persons.getAll(),
    db.keywords.getAll(),
    db.similarities.getAll(),
    db.configs.getAll(),
    db.schedules.getAll(),
  ]);
  return { persons, keywords, similarities, configs, schedules };
}

export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  const dbInst = await getDB();
  const tx = dbInst.transaction(
    ['persons', 'keywords', 'similarities', 'configs', 'schedules'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('persons').clear(),
    tx.objectStore('keywords').clear(),
    tx.objectStore('similarities').clear(),
    tx.objectStore('configs').clear(),
    tx.objectStore('schedules').clear(),
  ]);
  await Promise.all([
    ...dump.persons.map(p => tx.objectStore('persons').put(p)),
    ...dump.keywords.map(k => tx.objectStore('keywords').put(k)),
    ...dump.similarities.map(e => tx.objectStore('similarities').put(e)),
    ...dump.configs.map(c => tx.objectStore('configs').put(c)),
    ...dump.schedules.map(s => tx.objectStore('schedules').put(s)),
  ]);
  await tx.done;
}
