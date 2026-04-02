import type {
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

import { apiClient, ApiClient } from '@/lib/api.js';

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

  const similarities: SimilarityStore = {
    get: async (sourceId: string, targetId: string) => {
      const value = await client.request<SimilarityEdge | null>(`/db/similarities/${sourceId}/${targetId}`, { method: 'GET' });
      return value ?? undefined;
    },
    list: (query: ListQuery) => {
      const normalized = normalizeListQuery(query);
      const params = new URLSearchParams({
        offset: String(normalized.offset),
        limit: String(normalized.limit),
      });
      return client.request<PaginatedResult<SimilarityEdge>>(`/db/similarities?${params.toString()}`, { method: 'GET' });
    },
    put: (value: SimilarityEdge) => client.request<SimilarityEdge>(`/db/similarities/${value.sourceId}/${value.targetId}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }).then(() => undefined),
    delete: (sourceId: string, targetId: string) => client.request<void>(`/db/similarities/${sourceId}/${targetId}`, { method: 'DELETE' }),
    clear: async () => {
      const firstPage = await client.request<PaginatedResult<SimilarityEdge>>('/db/similarities?offset=0&limit=100', { method: 'GET' });
      let values = [...firstPage.items];
      let offset = firstPage.items.length;
      while (offset < firstPage.total) {
        const page = await client.request<PaginatedResult<SimilarityEdge>>(`/db/similarities?offset=${offset}&limit=100`, { method: 'GET' });
        values = values.concat(page.items);
        offset += page.items.length;
      }
      await Promise.all(values.map(value => client.request<void>(`/db/similarities/${value.sourceId}/${value.targetId}`, { method: 'DELETE' })));
    },
  };

  return {
    persons,
    keywords,
    similarities,
    configs,
    schedules,
    unavailabilities,
  };
}

export const apiDb = createApiDB();