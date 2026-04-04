/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, keyword_vectors, configs, schedules, unavailabilities.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type {
  DatabaseDump,
  Keyword,
  KeywordStore,
  KeywordVector,
  KeywordVectorStore,
  LabbyDB,
  Person,
  PersonStore,
  PersonUnavailability,
  PersonUnavailabilityStore,
  ScheduleConfig,
  ScheduleConfigStore,
  SchedulePlan,
  SchedulePlanStore,
  ListQuery,
  PaginatedResult,
} from '@labby/core';

const DB_NAME = 'labby';
const DB_VERSION = 3;

interface KeywordVectorRecord {
  keywordId: string;
  vector64: Float32Array;
  x: number;
  y: number;
  updatedAt: number;
}

function toKeywordVectorRecord(value: KeywordVector): KeywordVectorRecord {
  return {
    keywordId: value.keywordId,
    vector64: value.vector64 instanceof Float32Array ? value.vector64 : Float32Array.from(value.vector64),
    x: value.x,
    y: value.y,
    updatedAt: value.updatedAt,
  };
}

function fromKeywordVectorRecord(record: KeywordVectorRecord): KeywordVector {
  return {
    keywordId: record.keywordId,
    vector64: Array.from(record.vector64),
    x: record.x,
    y: record.y,
    updatedAt: record.updatedAt,
  };
}


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
      if (oldVersion < 3) {
        if (db.objectStoreNames.contains('similarities')) {
          db.deleteObjectStore('similarities');
        }
        if (!db.objectStoreNames.contains('keyword_vectors')) {
          db.createObjectStore('keyword_vectors', { keyPath: 'keywordId' });
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

  const keywordVectorsStore: KeywordVectorStore = {
    get: async (keywordId: string) => {
      const record = await idb.get('keyword_vectors', keywordId) as KeywordVectorRecord | undefined;
      return record ? fromKeywordVectorRecord(record) : undefined;
    },
    getMany: async (keywordIds: string[]) => {
      const tx = idb.transaction('keyword_vectors', 'readonly');
      const store = tx.objectStore('keyword_vectors');
      const values = await Promise.all(keywordIds.map((keywordId) => store.get(keywordId) as Promise<KeywordVectorRecord | undefined>));
      await tx.done;
      return values.filter((value): value is KeywordVectorRecord => Boolean(value)).map(fromKeywordVectorRecord);
    },
    list: async (query: ListQuery) => {
      const page = await listStore<KeywordVectorRecord>(idb, 'keyword_vectors', query);
      return {
        ...page,
        items: page.items.map(fromKeywordVectorRecord),
      };
    },
    put: (value: KeywordVector) => idb.put('keyword_vectors', toKeywordVectorRecord(value)).then(() => void 0),
    putMany: async (values: KeywordVector[]) => {
      if (values.length === 0) return;
      const tx = idb.transaction('keyword_vectors', 'readwrite');
      await Promise.all(values.map((value) => tx.objectStore('keyword_vectors').put(toKeywordVectorRecord(value))));
      await tx.done;
    },
    delete: (keywordId: string) => idb.delete('keyword_vectors', keywordId),
    clear: () => idb.clear('keyword_vectors'),
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
    keywordVectors: keywordVectorsStore,
    configs: configsStore,
    schedules: schedulesStore,
    unavailabilities: unavailabilitiesStore,
  };

  return db;

}


export async function restoreIDBDatabase(dbInst: IDBPDatabase, dump: DatabaseDump): Promise<void> {
  const storeNames = ['persons', 'keywords', 'keyword_vectors', 'configs', 'schedules', 'unavailabilities'] as const;
  const tx = dbInst.transaction(storeNames, 'readwrite');
  await Promise.all(storeNames.map(n => tx.objectStore(n).clear()));
  await Promise.all([
    ...dump.persons.map(p => tx.objectStore('persons').put(p)),
    ...dump.keywords.map(k => tx.objectStore('keywords').put(k)),
    ...(dump.keywordVectors?.map(v => tx.objectStore('keyword_vectors').put(toKeywordVectorRecord(v))) ?? []),
    ...dump.configs.map(c => tx.objectStore('configs').put(c)),
    ...dump.schedules.map(s => tx.objectStore('schedules').put(s)),
    ...dump.unavailabilities.map(u => tx.objectStore('unavailabilities').put(u)),
  ]);
  await tx.done;
}
