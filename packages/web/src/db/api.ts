import type {
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
  const schedules = createEntityStore<SchedulePlan>(client, '/db/schedules') satisfies SchedulePlanStore;
  const unavailabilities = createEntityStore<PersonUnavailability>(client, '/db/unavailabilities') satisfies PersonUnavailabilityStore;

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
    schedules,
    unavailabilities,
  };
}

export const apiDb = createApiDB();