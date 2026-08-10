import type {
  DatabaseDump,
  EmailTask,
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
  SystemSettings,
} from '@labby/core';

export const LEGACY_IDB_NAME = 'labby';
export const LEGACY_IDB_VERSION = 6;

const legacyStores = {
  persons: 'persons',
  keywords: 'keywords',
  keywordVectors: 'keyword_vectors',
  configs: 'configs',
  constraints: 'schedule_constraints',
  schedules: 'schedules',
  unavailabilities: 'unavailabilities',
  emailTasks: 'email_tasks',
} as const;

export interface LegacyEntityRow {
  kind: string;
  id: string;
  updated_at: number;
  payload: unknown;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function openExistingLegacyDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_IDB_NAME);
    let created = false;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        created = true;
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (created) resolve(null);
      else reject(request.error ?? new Error('Unable to open legacy IndexedDB database'));
    };
    request.onblocked = () => reject(new Error('Legacy IndexedDB upgrade is blocked by another open tab'));
  });
}

function openLegacyDatabaseAtCurrentVersion(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_IDB_NAME, LEGACY_IDB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to upgrade legacy IndexedDB database'));
    request.onblocked = () => reject(new Error('Legacy IndexedDB upgrade is blocked by another open tab'));
  });
}

async function openUpgradedLegacyDatabase(): Promise<IDBDatabase | null> {
  const existing = await openExistingLegacyDatabase();
  if (!existing) return null;
  if (existing.version >= LEGACY_IDB_VERSION) return existing;
  existing.close();
  return openLegacyDatabaseAtCurrentVersion();
}

function normalizeKeywordVector(record: unknown): KeywordVector {
  const value = record as KeywordVector & { vector64?: ArrayLike<number> };
  return {
    keywordId: value.keywordId,
    vector64: Array.from(value.vector64 ?? []),
    x: value.x,
    y: value.y,
    updatedAt: value.updatedAt,
  };
}

export async function readLegacyIndexedDbDump(): Promise<DatabaseDump | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openUpgradedLegacyDatabase();
  if (!database) return null;

  try {
    const existingStores = Object.values(legacyStores).filter(name => database.objectStoreNames.contains(name));
    if (existingStores.length === 0) return null;
    const transaction = database.transaction(existingStores, 'readonly');
    const completed = transactionDone(transaction);
    const records = new Map<string, unknown[]>();
    await Promise.all(existingStores.map(async (name) => {
      records.set(name, await requestResult(transaction.objectStore(name).getAll()));
    }));
    await completed;

    return {
      persons: (records.get(legacyStores.persons) ?? []) as Person[],
      keywords: (records.get(legacyStores.keywords) ?? []) as Keyword[],
      keywordVectors: (records.get(legacyStores.keywordVectors) ?? []).map(normalizeKeywordVector),
      configs: (records.get(legacyStores.configs) ?? []) as ScheduleConfig[],
      constraints: (records.get(legacyStores.constraints) ?? []) as ScheduleConstraint[],
      schedules: (records.get(legacyStores.schedules) ?? []) as SchedulePlan[],
      unavailabilities: (records.get(legacyStores.unavailabilities) ?? []) as PersonUnavailability[],
      emailTasks: (records.get(legacyStores.emailTasks) ?? []) as EmailTask[],
    };
  } finally {
    database.close();
  }
}

function entityTimestamp(value: unknown): number {
  const record = value as Record<string, unknown>;
  return Number(record.updatedAt ?? record.modifiedAt ?? record.createdAt ?? 0);
}

function row(kind: string, id: string, payload: unknown): LegacyEntityRow {
  return { kind, id, updated_at: entityTimestamp(payload), payload };
}

export function legacyDumpToEntityRows(dump: DatabaseDump): LegacyEntityRow[] {
  return [
    ...dump.persons.map(value => row('person', value.id, value)),
    ...dump.keywords.map(value => row('keyword', value.id, value)),
    ...dump.keywordVectors.map(value => row('keyword-vector', value.keywordId, {
      ...value,
      vector64: Array.from(value.vector64),
    })),
    ...dump.configs.map(value => row('config', value.id, value)),
    ...dump.constraints.map(value => row('constraint', value.id, value)),
    ...dump.schedules.map(value => row('schedule', value.id, value)),
    ...dump.unavailabilities.map(value => row('unavailability', value.id, {
      ...value,
      personIds: value.personIds?.length ? value.personIds : value.personId ? [value.personId] : [],
    })),
    ...dump.emailTasks.map(value => row('email-task', value.id, value)),
    ...(dump.systemSettings ? [row('system-settings', 'system', dump.systemSettings satisfies SystemSettings)] : []),
  ];
}
