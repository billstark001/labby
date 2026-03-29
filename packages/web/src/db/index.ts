/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, similarities, configs, schedules, unavailabilities.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Person, Keyword, SimilarityEdge, ScheduleConfig, SchedulePlan, PersonUnavailability } from '@labby/core';

const DB_NAME = 'labby';
const DB_VERSION = 2;

export interface LabbyDB {
  persons: Person;
  keywords: Keyword;
  similarities: SimilarityEdge;
  configs: ScheduleConfig;
  schedules: SchedulePlan;
  unavailabilities: PersonUnavailability;
}

let _db: IDBPDatabase | null = null;

export async function getDB(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('persons')) {
          db.createObjectStore('persons', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('keywords')) {
          db.createObjectStore('keywords', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('similarities')) {
          db.createObjectStore('similarities', { keyPath: ['sourceId', 'targetId'] });
        }
        if (!db.objectStoreNames.contains('configs')) {
          db.createObjectStore('configs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('schedules')) {
          const schedStore = db.createObjectStore('schedules', { keyPath: 'id' });
          schedStore.createIndex('createdAt', 'createdAt');
        }
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('unavailabilities')) {
          const store = db.createObjectStore('unavailabilities', { keyPath: 'id' });
          store.createIndex('configId', 'configId');
          store.createIndex('personId', 'personId');
        }
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
  unavailabilities: {
    getAll: () => getAll<PersonUnavailability>('unavailabilities'),
    put: (u: PersonUnavailability) => put('unavailabilities', u),
    delete: (id: string) => del('unavailabilities', id),
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
  unavailabilities?: PersonUnavailability[];
}

export async function dumpDatabase(): Promise<DatabaseDump> {
  const [persons, keywords, similarities, configs, schedules, unavailabilities] = await Promise.all([
    db.persons.getAll(),
    db.keywords.getAll(),
    db.similarities.getAll(),
    db.configs.getAll(),
    db.schedules.getAll(),
    db.unavailabilities.getAll(),
  ]);
  return { persons, keywords, similarities, configs, schedules, unavailabilities };
}

export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  const dbInst = await getDB();
  const storeNames = ['persons', 'keywords', 'similarities', 'configs', 'schedules', 'unavailabilities'] as const;
  const tx = dbInst.transaction(storeNames, 'readwrite');
  await Promise.all(storeNames.map(n => tx.objectStore(n).clear()));
  await Promise.all([
    ...dump.persons.map(p => tx.objectStore('persons').put(p)),
    ...dump.keywords.map(k => tx.objectStore('keywords').put(k)),
    ...dump.similarities.map(e => tx.objectStore('similarities').put(e)),
    ...dump.configs.map(c => tx.objectStore('configs').put(c)),
    ...dump.schedules.map(s => tx.objectStore('schedules').put(s)),
    ...(dump.unavailabilities ?? []).map(u => tx.objectStore('unavailabilities').put(u)),
  ]);
  await tx.done;
}
