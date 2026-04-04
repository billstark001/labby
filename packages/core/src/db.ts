import type {
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
} from './types.js';

export interface ListQuery {
  offset: number;
  limit: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PersonStore {
  get(id: string): Promise<Person | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<Person>>;
  put(value: Person): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeywordStore {
  get(id: string): Promise<Keyword | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<Keyword>>;
  put(value: Keyword): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeywordVectorStore {
  get(keywordId: string): Promise<KeywordVector | undefined>;
  getMany(keywordIds: string[]): Promise<KeywordVector[]>;
  list(query: ListQuery): Promise<PaginatedResult<KeywordVector>>;
  put(value: KeywordVector): Promise<void>;
  putMany(values: KeywordVector[]): Promise<void>;
  delete(keywordId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ScheduleConfigStore {
  get(id: string): Promise<ScheduleConfig | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<ScheduleConfig>>;
  put(value: ScheduleConfig): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SchedulePlanStore {
  get(id: string): Promise<SchedulePlan | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<SchedulePlan>>;
  put(value: SchedulePlan): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PersonUnavailabilityStore {
  get(id: string): Promise<PersonUnavailability | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<PersonUnavailability>>;
  put(value: PersonUnavailability): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface LabbyDB {
  persons: PersonStore;
  keywords: KeywordStore;
  keywordVectors: KeywordVectorStore;
  configs: ScheduleConfigStore;
  schedules: SchedulePlanStore;
  unavailabilities: PersonUnavailabilityStore;
}

export interface DatabaseDump {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
}