/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, similarities, configs, schedules, unavailabilities.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type {
  DatabaseDump,
  Keyword,
  KeywordStore,
  LabbyDB,
  Person,
  PersonStore,
  PersonUnavailability,
  PersonUnavailabilityStore,
  ScheduleConfig,
  ScheduleConfigStore,
  SchedulePlan,
  SchedulePlanStore,
  SimilarityEdge,
  SimilarityStore,
  ListQuery,
  PaginatedResult,
} from '@labby/core';

const DB_NAME = 'labby';
const DB_VERSION = 2;


export async function createDB(): Promise<IDBPDatabase> {
  const idb = await openDB(DB_NAME, DB_VERSION, {
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
          const scheduleStore = db.createObjectStore('schedules', { keyPath: 'id' });
          scheduleStore.createIndex('createdAt', 'createdAt');
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
  return idb;
}

function normalizeListQuery(query: ListQuery): ListQuery {
  return {
    offset: Math.max(0, Math.floor(query.offset)),
    limit: Math.max(1, Math.floor(query.limit)),
  };
}

async function listStore<T>(idb: IDBPDatabase, storeName: string, query: ListQuery): Promise<PaginatedResult<T>> {
  const { offset, limit } = normalizeListQuery(query);
  const tx = idb.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const total = await store.count();

  if (offset >= total) {
    await tx.done;
    return { items: [], total, offset, limit };
  }

  const items: T[] = [];
  let cursor = await store.openCursor();
  let skipped = 0;
  while (cursor && skipped < offset) {
    cursor = await cursor.continue();
    skipped += 1;
  }

  while (cursor && items.length < limit) {
    items.push(cursor.value as T);
    cursor = await cursor.continue();
  }

  await tx.done;
  return { items, total, offset, limit };
}

export function createIDB(idb: IDBPDatabase): LabbyDB {

  const personsStore: PersonStore = {
    get: (id: string) => idb.get('persons', id),
    list: (query: ListQuery) => listStore<Person>(idb, 'persons', query),
    put: (value: Person) => idb.put('persons', value).then(() => void 0),
    delete: (id: string) => idb.delete('persons', id),
    clear: () => idb.clear('persons'),
  };

  const keywordsStore: KeywordStore = {
    get: (id: string) => idb.get('keywords', id),
    list: (query: ListQuery) => listStore<Keyword>(idb, 'keywords', query),
    put: (value: Keyword) => idb.put('keywords', value).then(() => void 0),
    delete: (id: string) => idb.delete('keywords', id),
    clear: () => idb.clear('keywords'),
  };

  const similaritiesStore: SimilarityStore = {
    get: (sourceId: string, targetId: string) => idb.get('similarities', [sourceId, targetId]),
    list: (query: ListQuery) => listStore<SimilarityEdge>(idb, 'similarities', query),
    put: (value: SimilarityEdge) => idb.put('similarities', value).then(() => void 0),
    delete: (sourceId: string, targetId: string) => idb.delete('similarities', [sourceId, targetId]),
    clear: () => idb.clear('similarities'),
  };

  const configsStore: ScheduleConfigStore = {
    get: (id: string) => idb.get('configs', id),
    list: (query: ListQuery) => listStore<ScheduleConfig>(idb, 'configs', query),
    put: (value: ScheduleConfig) => idb.put('configs', value).then(() => void 0),
    delete: (id: string) => idb.delete('configs', id),
    clear: () => idb.clear('configs'),
  };

  const schedulesStore: SchedulePlanStore = {
    get: (id: string) => idb.get('schedules', id),
    list: (query: ListQuery) => listStore<SchedulePlan>(idb, 'schedules', query),
    put: (value: SchedulePlan) => idb.put('schedules', value).then(() => void 0),
    delete: (id: string) => idb.delete('schedules', id),
    clear: () => idb.clear('schedules'),
  };

  const unavailabilitiesStore: PersonUnavailabilityStore = {
    get: (id: string) => idb.get('unavailabilities', id),
    list: (query: ListQuery) => listStore<PersonUnavailability>(idb, 'unavailabilities', query),
    put: (value: PersonUnavailability) => idb.put('unavailabilities', value).then(() => void 0),
    delete: (id: string) => idb.delete('unavailabilities', id),
    clear: () => idb.clear('unavailabilities'),
  };

  const db: LabbyDB = {
    persons: personsStore,
    keywords: keywordsStore,
    similarities: similaritiesStore,
    configs: configsStore,
    schedules: schedulesStore,
    unavailabilities: unavailabilitiesStore,
  };

  return db;

}


export async function restoreIDBDatabase(dbInst: IDBPDatabase, dump: DatabaseDump): Promise<void> {
  const storeNames = ['persons', 'keywords', 'similarities', 'configs', 'schedules', 'unavailabilities'] as const;
  const tx = dbInst.transaction(storeNames, 'readwrite');
  await Promise.all(storeNames.map(n => tx.objectStore(n).clear()));
  await Promise.all([
    ...dump.persons.map(p => tx.objectStore('persons').put(p)),
    ...dump.keywords.map(k => tx.objectStore('keywords').put(k)),
    ...dump.similarities.map(e => tx.objectStore('similarities').put(e)),
    ...dump.configs.map(c => tx.objectStore('configs').put(c)),
    ...dump.schedules.map(s => tx.objectStore('schedules').put(s)),
    ...dump.unavailabilities.map(u => tx.objectStore('unavailabilities').put(u)),
  ]);
  await tx.done;
}
