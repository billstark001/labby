import type {
  Keyword,
  KeywordStore,
  LabbyDB,
  ListQuery,
  PaginatedResult,
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

function emptyPage<T>(query: ListQuery): PaginatedResult<T> {
  return {
    items: [],
    total: 0,
    offset: Math.max(0, Math.floor(query.offset)),
    limit: Math.max(1, Math.floor(query.limit)),
  };
}


export function createDummyDB(): LabbyDB {

  const personsStore: PersonStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<Person>(query),
    put: async (value: Person) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const keywordsStore: KeywordStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<Keyword>(query),
    put: async (value: Keyword) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const similaritiesStore: SimilarityStore = {
    get: async (sourceId: string, targetId: string) => undefined,
    list: async (query: ListQuery) => emptyPage<SimilarityEdge>(query),
    put: async (value: SimilarityEdge) => void 0,
    delete: async (sourceId: string, targetId: string) => void 0,
    clear: async () => void 0,
  };

  const configsStore: ScheduleConfigStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<ScheduleConfig>(query),
    put: async (value: ScheduleConfig) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const schedulesStore: SchedulePlanStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<SchedulePlan>(query),
    put: async (value: SchedulePlan) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const unavailabilitiesStore: PersonUnavailabilityStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<PersonUnavailability>(query),
    put: async (value: PersonUnavailability) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
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