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
} from '@labby/core';

import { apiClient, ApiClient } from '@/lib/api.js';

function createEntityStore<T extends { id: string }>(client: ApiClient, path: string) {
  return {
    get: async (id: string) => {
      const value = await client.request<T | null>(`${path}/${id}`, { method: 'GET' });
      return value ?? undefined;
    },
    getAll: () => client.request<T[]>(path, { method: 'GET' }),
    put: (value: T) => client.request<T>(`${path}/${value.id}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }).then(() => undefined),
    delete: (id: string) => client.request<void>(`${path}/${id}`, { method: 'DELETE' }),
    clear: async () => {
      const values = await client.request<T[]>(path, { method: 'GET' });
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
    getAll: () => client.request<SimilarityEdge[]>('/db/similarities', { method: 'GET' }),
    put: (value: SimilarityEdge) => client.request<SimilarityEdge>(`/db/similarities/${value.sourceId}/${value.targetId}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }).then(() => undefined),
    delete: (sourceId: string, targetId: string) => client.request<void>(`/db/similarities/${sourceId}/${targetId}`, { method: 'DELETE' }),
    clear: async () => {
      const values = await client.request<SimilarityEdge[]>('/db/similarities', { method: 'GET' });
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