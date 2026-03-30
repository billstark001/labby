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


export function createDummyDB(): LabbyDB {

  const personsStore: PersonStore = {
    get: async (id: string) => undefined,
    getAll: async () => [],
    put: async (value: Person) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const keywordsStore: KeywordStore = {
    get: async (id: string) => undefined,
    getAll: async () => [],
    put: async (value: Keyword) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const similaritiesStore: SimilarityStore = {
    get: async (sourceId: string, targetId: string) => undefined,
    getAll: async () => [],
    put: async (value: SimilarityEdge) => void 0,
    delete: async (sourceId: string, targetId: string) => void 0,
    clear: async () => void 0,
  };

  const configsStore: ScheduleConfigStore = {
    get: async (id: string) => undefined,
    getAll: async () => [],
    put: async (value: ScheduleConfig) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const schedulesStore: SchedulePlanStore = {
    get: async (id: string) => undefined,
    getAll: async () => [],
    put: async (value: SchedulePlan) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const unavailabilitiesStore: PersonUnavailabilityStore = {
    get: async (id: string) => undefined,
    getAll: async () => [],
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