import type {
  EmailTask,
  EmailTaskStore,
  KeywordForeignKeyQuery,
  KeywordForeignKeyBundle,
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
  ScheduleConstraint,
  ScheduleForeignKeyQuery,
  ScheduleForeignKeyBundle,
  PersonForeignKeyQuery,
  PersonForeignKeyBundle,
  ScheduleConstraintStore,
  SchedulePlan,
  SchedulePlanStore,
  ListQuery,
  PaginatedResult,
} from '@labby/core';

import { apiClient, ApiClient } from '@/lib/api';

function normalizeListQuery(query: ListQuery): ListQuery {
  return {
    offset: Math.max(0, Math.floor(query.offset)),
    limit: Math.max(1, Math.floor(query.limit)),
  };
}

function createEntityStore<T extends { id: string }>(client: ApiClient, path: string) {
  return {
    get: async (id: string) => {
      const value = await client.request<T | null>(`${path}/${id}`, { method: 'GET' });
      return value ?? undefined;
    },
    list: (query: ListQuery) => {
      const normalized = normalizeListQuery(query);
      const params = new URLSearchParams({
        offset: String(normalized.offset),
        limit: String(normalized.limit),
      });
      return client.request<PaginatedResult<T>>(`${path}?${params.toString()}`, { method: 'GET' });
    },
    put: (value: T) => client.request<T>(`${path}/${value.id}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }).then(() => undefined),
    delete: (id: string) => client.request<void>(`${path}/${id}`, { method: 'DELETE' }),
    clear: async () => {
      const firstPage = await client.request<PaginatedResult<T>>(`${path}?offset=0&limit=100`, { method: 'GET' });
      let values = [...firstPage.items];
      let offset = firstPage.items.length;
      while (offset < firstPage.total) {
        const page = await client.request<PaginatedResult<T>>(`${path}?offset=${offset}&limit=100`, { method: 'GET' });
        values = values.concat(page.items);
        offset += page.items.length;
      }
      await Promise.all(values.map(value => client.request<void>(`${path}/${value.id}`, { method: 'DELETE' })));
    },
  };
}

export function createApiDB(client: ApiClient = apiClient): LabbyDB {
  const persons = createEntityStore<Person>(client, '/db/persons') satisfies PersonStore;
  const keywords = createEntityStore<Keyword>(client, '/db/keywords') satisfies KeywordStore;
  const configs = createEntityStore<ScheduleConfig>(client, '/db/configs') satisfies ScheduleConfigStore;
  const constraints = createEntityStore<ScheduleConstraint>(client, '/db/constraints') satisfies ScheduleConstraintStore;
  const schedules = createEntityStore<SchedulePlan>(client, '/db/schedules') satisfies SchedulePlanStore;
  const unavailabilities = createEntityStore<PersonUnavailability>(client, '/db/unavailabilities') satisfies PersonUnavailabilityStore;
  const emailTasks = createEntityStore<EmailTask>(client, '/db/email-tasks') satisfies EmailTaskStore;

  const normalizedUnavailabilities: PersonUnavailabilityStore = {
    ...unavailabilities,
    put: (value: PersonUnavailability) => {
      const normalizedPersonIds = Array.isArray(value.personIds) && value.personIds.length > 0
        ? value.personIds
        : (value.personId ? [value.personId] : []);
      return unavailabilities.put({
        ...value,
        personId: normalizedPersonIds[0],
        personIds: normalizedPersonIds,
      });
    },
  };

  const foreignKeys = {
    readForSchedule: (query: ScheduleForeignKeyQuery) => client.request<ScheduleForeignKeyBundle>('/db/foreign-keys/schedule', {
      method: 'POST',
      body: JSON.stringify(query),
    }),
    readForPerson: (query: PersonForeignKeyQuery) => client.request<PersonForeignKeyBundle>('/db/foreign-keys/person', {
      method: 'POST',
      body: JSON.stringify(query),
    }),
    readForKeyword: (query: KeywordForeignKeyQuery) => client.request<KeywordForeignKeyBundle>('/db/foreign-keys/keyword', {
      method: 'POST',
      body: JSON.stringify(query),
    }),
  };

  const keywordVectors: KeywordVectorStore = {
    get: async (keywordId: string) => {
      const value = await client.request<KeywordVector | null>(`/db/keyword-vectors/${keywordId}`, { method: 'GET' });
      return value ?? undefined;
    },
    getMany: async (keywordIds: string[]) => {
      const tasks = keywordIds.map((keywordId) =>
        client.request<KeywordVector | null>(`/db/keyword-vectors/${keywordId}`, { method: 'GET' }),
      );
      const values = await Promise.all(tasks);
      return values.filter((value): value is KeywordVector => Boolean(value));
    },
    list: (query: ListQuery) => {
      const normalized = normalizeListQuery(query);
      const params = new URLSearchParams({
        offset: String(normalized.offset),
        limit: String(normalized.limit),
      });
      return client.request<PaginatedResult<KeywordVector>>(`/db/keyword-vectors?${params.toString()}`, { method: 'GET' });
    },
    put: (value: KeywordVector) => client.request<KeywordVector>(`/db/keyword-vectors/${value.keywordId}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }).then(() => undefined),
    putMany: async (values: KeywordVector[]) => {
      await Promise.all(values.map((value) =>
        client.request<KeywordVector>(`/db/keyword-vectors/${value.keywordId}`, {
          method: 'PUT',
          body: JSON.stringify(value),
        }),
      ));
    },
    delete: (keywordId: string) => client.request<void>(`/db/keyword-vectors/${keywordId}`, { method: 'DELETE' }),
    clear: async () => {
      const firstPage = await client.request<PaginatedResult<KeywordVector>>('/db/keyword-vectors?offset=0&limit=100', { method: 'GET' });
      let values = [...firstPage.items];
      let offset = firstPage.items.length;
      while (offset < firstPage.total) {
        const page = await client.request<PaginatedResult<KeywordVector>>(`/db/keyword-vectors?offset=${offset}&limit=100`, { method: 'GET' });
        values = values.concat(page.items);
        offset += page.items.length;
      }
      await Promise.all(values.map(value => client.request<void>(`/db/keyword-vectors/${value.keywordId}`, { method: 'DELETE' })));
    },
  };

  return {
    persons,
    keywords,
    keywordVectors,
    configs,
    constraints,
    schedules,
    unavailabilities: normalizedUnavailabilities,
    emailTasks,
    foreignKeys,
  };
}

export const apiDb = createApiDB();