import type {
  EmailTask,
  EmailTaskStore,
  Keyword,
  KeywordStore,
  KeywordVector,
  KeywordVectorStore,
  LabbyDB,
  ListQuery,
  PaginatedResult,
  Person,
  PersonStore,
  PersonUnavailability,
  PersonUnavailabilityStore,
  ScheduleConfig,
  ScheduleConfigStore,
  ScheduleConstraint,
  ScheduleConstraintStore,
  SchedulePlan,
  SchedulePlanStore,
  SystemSettings,
  SystemSettingsStore,
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

  const keywordVectorsStore: KeywordVectorStore = {
    get: async (keywordId: string) => undefined,
    getMany: async (keywordIds: string[]) => [],
    list: async (query: ListQuery) => emptyPage<KeywordVector>(query),
    put: async (value: KeywordVector) => void 0,
    putMany: async (values: KeywordVector[]) => void 0,
    delete: async (keywordId: string) => void 0,
    clear: async () => void 0,
  };

  const configsStore: ScheduleConfigStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<ScheduleConfig>(query),
    put: async (value: ScheduleConfig) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const constraintsStore: ScheduleConstraintStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<ScheduleConstraint>(query),
    put: async (value: ScheduleConstraint) => void 0,
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

  const emailTasksStore: EmailTaskStore = {
    get: async (id: string) => undefined,
    list: async (query: ListQuery) => emptyPage<EmailTask>(query),
    put: async (value: EmailTask) => void 0,
    delete: async (id: string) => void 0,
    clear: async () => void 0,
  };

  const systemSettingsStore: SystemSettingsStore = {
    get: async () => ({ id: 'system' }),
    put: async (value: SystemSettings) => void 0,
  };

  const db: LabbyDB = {
    similarity: { getHistory: async () => [], forgetJudgment: async () => { throw new Error('Database is unavailable'); }, commit: async () => { throw new Error('Database is unavailable'); } },
    persons: personsStore,
    keywords: keywordsStore,
    keywordVectors: keywordVectorsStore,
    configs: configsStore,
    constraints: constraintsStore,
    schedules: schedulesStore,
    unavailabilities: unavailabilitiesStore,
    emailTasks: emailTasksStore,
    systemSettings: systemSettingsStore,
    foreignKeys: {
      readForSchedule: async (_query) => ({
        persons: [],
        keywords: [],
        keywordVectors: [],
        configs: [],
        constraints: [],
        schedules: [],
        unavailabilities: [],
      }),
      readForPerson: async (_query) => ({
        keywords: [],
        constraints: [],
        schedules: [],
        unavailabilities: [],
      }),
      readForKeyword: async (_query) => ({
        persons: [],
        keywords: [],
        keywordVectors: [],
      }),
    },
    graph: {
      list: async () => ({ items: [], nextCursor: null, checkpoint: 'dummy', reset: false }),
    },
  };

  return db;
}
