/**
 * IndexedDB abstraction using the `idb` library.
 * Object stores: persons, keywords, keyword_vectors, configs, schedules, unavailabilities.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type {
  DatabaseDump,
  EntityListSortBy,
  EmailTask,
  EmailTaskStore,
  KeywordForeignKeyQuery,
  KeywordForeignKeyBundle,
  Keyword,
  KeywordStore,
  KeywordVector,
  KeywordVectorStore,
  LabbyDB,
  ListSortDirection,
  Person,
  PersonForeignKeyQuery,
  PersonStore,
  PersonUnavailability,
  PersonUnavailabilityStore,
  ScheduleConfig,
  ScheduleConfigStore,
  ScheduleConstraint,
  ScheduleForeignKeyQuery,
  ScheduleForeignKeyBundle,
  PersonForeignKeyBundle,
  ScheduleConstraintStore,
  SchedulePlan,
  SchedulePlanStore,
  ListQuery,
  PaginatedResult,
} from '@labby/core';

const DB_NAME = 'labby';
const DB_VERSION = 5;

type EntityListSort = {
  sortBy: EntityListSortBy;
  sortDirection: ListSortDirection;
};

type SortableEntity = {
  id: string;
  modifiedAt?: number;
  name?: string;
  notes?: string;
};

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
      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains('email_tasks')) {
          const store = db.createObjectStore('email_tasks', { keyPath: 'id' });
          store.createIndex('configId', 'configId');
        }
      }
      if (oldVersion < 5) {
        if (!db.objectStoreNames.contains('schedule_constraints')) {
          const store = db.createObjectStore('schedule_constraints', { keyPath: 'id' });
          store.createIndex('configId', 'configId', { unique: false });
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
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
  };
}

function normalizeEntitySort(query: ListQuery): EntityListSort {
  const sortBy = query.sortBy ?? 'modifiedAt';
  const sortDirection = query.sortDirection ?? (sortBy === 'modifiedAt' ? 'desc' : 'asc');
  return { sortBy, sortDirection };
}

function normalizeSortText(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function compareText(left: string | undefined, right: string | undefined, direction: ListSortDirection): number {
  const diff = normalizeSortText(left).localeCompare(normalizeSortText(right));
  return direction === 'asc' ? diff : -diff;
}

function compareNumber(left: number | undefined, right: number | undefined, direction: ListSortDirection): number {
  const diff = (left ?? 0) - (right ?? 0);
  return direction === 'asc' ? diff : -diff;
}

function compareSortableEntities<T extends SortableEntity>(left: T, right: T, query: ListQuery): number {
  const resolved = normalizeEntitySort(query);
  const comparators: Array<(leftItem: T, rightItem: T) => number> = [];

  if (resolved.sortBy === 'modifiedAt') {
    comparators.push((leftItem, rightItem) => compareNumber(leftItem.modifiedAt, rightItem.modifiedAt, resolved.sortDirection));
  }
  if (resolved.sortBy === 'name') {
    comparators.push((leftItem, rightItem) => compareText(leftItem.name, rightItem.name, resolved.sortDirection));
  }
  if (resolved.sortBy === 'notes') {
    comparators.push((leftItem, rightItem) => compareText(leftItem.notes, rightItem.notes, resolved.sortDirection));
  }

  comparators.push(
    (leftItem, rightItem) => compareNumber(leftItem.modifiedAt, rightItem.modifiedAt, 'desc'),
    (leftItem, rightItem) => compareText(leftItem.name, rightItem.name, 'asc'),
    (leftItem, rightItem) => compareText(leftItem.notes, rightItem.notes, 'asc'),
    (leftItem, rightItem) => compareText(leftItem.id, rightItem.id, 'asc'),
  );

  for (const comparator of comparators) {
    const diff = comparator(left, right);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
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

async function listAllStore<T>(idb: IDBPDatabase, storeName: string): Promise<T[]> {
  const tx = idb.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const values = await store.getAll();
  await tx.done;
  return values as T[];
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function hasAnyOverlap(left: readonly string[], right: Set<string>): boolean {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
}

async function listStoreSorted<T>(
  idb: IDBPDatabase,
  storeName: string,
  query: ListQuery,
  sortBy: (item: T) => number,
): Promise<PaginatedResult<T>> {
  const { offset, limit } = normalizeListQuery(query);
  const tx = idb.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const all = (await store.getAll()) as T[];
  await tx.done;
  const sorted = [...all].sort((left, right) => {
    const diff = sortBy(right) - sortBy(left);
    if (diff !== 0) return diff;
    return 0;
  });
  return {
    items: sorted.slice(offset, offset + limit),
    total: sorted.length,
    offset,
    limit,
  };
}

async function listStoreByComparator<T>(
  idb: IDBPDatabase,
  storeName: string,
  query: ListQuery,
  compare: (left: T, right: T, query: ListQuery) => number,
): Promise<PaginatedResult<T>> {
  const { offset, limit } = normalizeListQuery(query);
  const tx = idb.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const all = (await store.getAll()) as T[];
  await tx.done;
  const sorted = [...all].sort((left, right) => compare(left, right, query));
  return {
    items: sorted.slice(offset, offset + limit),
    total: sorted.length,
    offset,
    limit,
  };
}

export function createIDB(idb: IDBPDatabase): LabbyDB {

  const personsStore: PersonStore = {
    get: (id: string) => idb.get('persons', id),
    list: (query: ListQuery) => listStoreByComparator<Person>(idb, 'persons', query, compareSortableEntities),
    put: (value: Person) => idb.put('persons', value).then(() => void 0),
    delete: (id: string) => idb.delete('persons', id),
    clear: () => idb.clear('persons'),
  };

  const keywordsStore: KeywordStore = {
    get: (id: string) => idb.get('keywords', id),
    list: (query: ListQuery) => listStoreByComparator<Keyword>(idb, 'keywords', query, compareSortableEntities),
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
      const page = await listStoreSorted<KeywordVectorRecord>(idb, 'keyword_vectors', query, (item) => item.updatedAt ?? 0);
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
    list: (query: ListQuery) => listStoreSorted<ScheduleConfig>(idb, 'configs', query, (item) => item.modifiedAt ?? 0),
    put: (value: ScheduleConfig) => idb.put('configs', value).then(() => void 0),
    delete: (id: string) => idb.delete('configs', id),
    clear: () => idb.clear('configs'),
  };

  const constraintsStore: ScheduleConstraintStore = {
    get: (id: string) => idb.get('schedule_constraints', id),
    list: (query: ListQuery) => listStoreSorted<ScheduleConstraint>(idb, 'schedule_constraints', query, (item) => item.modifiedAt ?? 0),
    put: (value: ScheduleConstraint) => idb.put('schedule_constraints', value).then(() => void 0),
    delete: (id: string) => idb.delete('schedule_constraints', id),
    clear: () => idb.clear('schedule_constraints'),
  };

  const schedulesStore: SchedulePlanStore = {
    get: (id: string) => idb.get('schedules', id),
    list: (query: ListQuery) => listStoreSorted<SchedulePlan>(idb, 'schedules', query, (item) => item.modifiedAt ?? item.createdAt ?? 0),
    put: (value: SchedulePlan) => idb.put('schedules', value).then(() => void 0),
    delete: (id: string) => idb.delete('schedules', id),
    clear: () => idb.clear('schedules'),
  };

  const unavailabilitiesStore: PersonUnavailabilityStore = {
    get: (id: string) => idb.get('unavailabilities', id),
    list: (query: ListQuery) => listStore<PersonUnavailability>(idb, 'unavailabilities', query),
    put: (value: PersonUnavailability) => {
      const normalizedPersonIds = Array.isArray(value.personIds) && value.personIds.length > 0
        ? value.personIds
        : (value.personId ? [value.personId] : []);
      return idb.put('unavailabilities', {
        ...value,
        personId: normalizedPersonIds[0],
        personIds: normalizedPersonIds,
      }).then(() => void 0);
    },
    delete: (id: string) => idb.delete('unavailabilities', id),
    clear: () => idb.clear('unavailabilities'),
  };

  const emailTasksStore: EmailTaskStore = {
    get: (id: string) => idb.get('email_tasks', id),
    list: (query: ListQuery) => listStoreSorted<EmailTask>(idb, 'email_tasks', query, (item) => item.modifiedAt ?? 0),
    put: (value: EmailTask) => idb.put('email_tasks', value).then(() => void 0),
    delete: (id: string) => idb.delete('email_tasks', id),
    clear: () => idb.clear('email_tasks'),
  };

  const foreignKeysStore = {
    readForSchedule: async (query: ScheduleForeignKeyQuery): Promise<ScheduleForeignKeyBundle> => {
      const configIds = uniqueIds(query.configIds ?? []);
      if (configIds.length === 0) {
        return {
          persons: [],
          keywords: [],
          keywordVectors: [],
          configs: [],
          constraints: [],
          schedules: [],
          unavailabilities: [],
        };
      }
      const configSet = new Set(configIds);
      const [allConfigs, allConstraints, allSchedules, allUnavailabilities, allPersons, allKeywords, allKeywordVectorRecords] = await Promise.all([
        listAllStore<ScheduleConfig>(idb, 'configs'),
        listAllStore<ScheduleConstraint>(idb, 'schedule_constraints'),
        listAllStore<SchedulePlan>(idb, 'schedules'),
        listAllStore<PersonUnavailability>(idb, 'unavailabilities'),
        listAllStore<Person>(idb, 'persons'),
        listAllStore<Keyword>(idb, 'keywords'),
        listAllStore<KeywordVectorRecord>(idb, 'keyword_vectors'),
      ]);

      const configs = allConfigs.filter((item) => configSet.has(item.id));
      const schedules = allSchedules.filter((item) => configSet.has(item.configId));
      const constraints = allConstraints.filter((item) => !item.configId || configSet.has(item.configId));
      const unavailabilities = allUnavailabilities.filter((item) => configSet.has(item.configId));

      const personIdSet = new Set<string>();
      for (const schedule of schedules) {
        for (const session of schedule.sessions) {
          for (const presentation of session.presentations) {
            personIdSet.add(presentation.presenterId);
            for (const questionerId of presentation.questionerIds) {
              personIdSet.add(questionerId);
            }
          }
        }
      }
      for (const unavailability of unavailabilities) {
        const ids = Array.isArray(unavailability.personIds) && unavailability.personIds.length > 0
          ? unavailability.personIds
          : (unavailability.personId ? [unavailability.personId] : []);
        for (const id of ids) personIdSet.add(id);
      }
      for (const constraint of constraints) {
        const ids = Array.isArray((constraint as { personIds?: unknown }).personIds)
          ? ((constraint as { personIds: string[] }).personIds)
          : [];
        for (const id of ids) personIdSet.add(id);
      }

      const persons = allPersons.filter((item) => personIdSet.has(item.id));
      const keywordIdSet = new Set<string>();
      for (const person of persons) {
        for (const keywordId of person.keywordIds) {
          keywordIdSet.add(keywordId);
        }
      }
      const keywords = allKeywords.filter((item) => keywordIdSet.has(item.id));
      const keywordVectors = allKeywordVectorRecords
        .filter((item) => keywordIdSet.has(item.keywordId))
        .map(fromKeywordVectorRecord);

      return {
        persons,
        keywords,
        keywordVectors,
        configs,
        constraints,
        schedules,
        unavailabilities,
      };
    },
    readForPerson: async (query: PersonForeignKeyQuery): Promise<PersonForeignKeyBundle> => {
      const personIds = uniqueIds(query.personIds ?? []);
      if (personIds.length === 0) {
        return {
          keywords: [],
          constraints: [],
          schedules: [],
          unavailabilities: [],
        };
      }
      const personSet = new Set(personIds);
      const [allPersons, allKeywords, allConstraints, allSchedules, allUnavailabilities] = await Promise.all([
        listAllStore<Person>(idb, 'persons'),
        listAllStore<Keyword>(idb, 'keywords'),
        listAllStore<ScheduleConstraint>(idb, 'schedule_constraints'),
        listAllStore<SchedulePlan>(idb, 'schedules'),
        listAllStore<PersonUnavailability>(idb, 'unavailabilities'),
      ]);

      const selectedPersons = allPersons.filter((item) => personSet.has(item.id));
      const keywordIdSet = new Set<string>();
      for (const person of selectedPersons) {
        for (const keywordId of person.keywordIds) keywordIdSet.add(keywordId);
      }
      const keywords = allKeywords.filter((item) => keywordIdSet.has(item.id));

      const constraints = allConstraints.filter((item) => {
        const ids = Array.isArray((item as { personIds?: unknown }).personIds)
          ? ((item as { personIds: string[] }).personIds)
          : [];
        return hasAnyOverlap(ids, personSet);
      });
      const schedules = allSchedules.filter((item) => {
        for (const session of item.sessions) {
          for (const presentation of session.presentations) {
            if (personSet.has(presentation.presenterId)) return true;
            if (hasAnyOverlap(presentation.questionerIds, personSet)) return true;
          }
        }
        return false;
      });
      const unavailabilities = allUnavailabilities.filter((item) => {
        const ids = Array.isArray(item.personIds) && item.personIds.length > 0
          ? item.personIds
          : (item.personId ? [item.personId] : []);
        return hasAnyOverlap(ids, personSet);
      });

      return {
        keywords,
        constraints,
        schedules,
        unavailabilities,
      };
    },
    readForKeyword: async (query: KeywordForeignKeyQuery): Promise<KeywordForeignKeyBundle> => {
      const keywordIds = uniqueIds(query.keywordIds ?? []);
      if (keywordIds.length === 0) {
        return {
          persons: [],
          keywords: [],
          keywordVectors: [],
        };
      }
      const keywordSet = new Set(keywordIds);
      const [allPersons, allKeywords, allKeywordVectorRecords] = await Promise.all([
        listAllStore<Person>(idb, 'persons'),
        listAllStore<Keyword>(idb, 'keywords'),
        listAllStore<KeywordVectorRecord>(idb, 'keyword_vectors'),
      ]);
      const persons = allPersons.filter((item) => hasAnyOverlap(item.keywordIds, keywordSet));
      const keywords = allKeywords.filter((item) => keywordSet.has(item.id));
      const keywordVectors = allKeywordVectorRecords
        .filter((item) => keywordSet.has(item.keywordId))
        .map(fromKeywordVectorRecord);
      return {
        persons,
        keywords,
        keywordVectors,
      };
    },
  };

  const db: LabbyDB = {
    persons: personsStore,
    keywords: keywordsStore,
    keywordVectors: keywordVectorsStore,
    configs: configsStore,
    constraints: constraintsStore,
    schedules: schedulesStore,
    unavailabilities: unavailabilitiesStore,
    emailTasks: emailTasksStore,
    foreignKeys: foreignKeysStore,
  };

  return db;

}


export async function restoreIDBDatabase(dbInst: IDBPDatabase, dump: DatabaseDump): Promise<void> {
  const storeNames = ['persons', 'keywords', 'keyword_vectors', 'configs', 'schedule_constraints', 'schedules', 'unavailabilities', 'email_tasks'] as const;
  const tx = dbInst.transaction(storeNames, 'readwrite');
  await Promise.all(storeNames.map(n => tx.objectStore(n).clear()));
  await Promise.all([
    ...dump.persons.map(p => tx.objectStore('persons').put(p)),
    ...dump.keywords.map(k => tx.objectStore('keywords').put(k)),
    ...(dump.keywordVectors?.map(v => tx.objectStore('keyword_vectors').put(toKeywordVectorRecord(v))) ?? []),
    ...dump.configs.map(c => tx.objectStore('configs').put(c)),
    ...(dump.constraints?.map(c => tx.objectStore('schedule_constraints').put(c)) ?? []),
    ...dump.schedules.map(s => tx.objectStore('schedules').put(s)),
    ...dump.unavailabilities.map(u => tx.objectStore('unavailabilities').put(u)),
    ...dump.emailTasks.map(e => tx.objectStore('email_tasks').put(e)),
  ]);
  await tx.done;
}
