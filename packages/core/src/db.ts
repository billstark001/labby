import type {
  Keyword,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
  SimilarityEdge,
} from './types';

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

export interface SimilarityStore {
  get(sourceId: string, targetId: string): Promise<SimilarityEdge | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<SimilarityEdge>>;
  put(value: SimilarityEdge): Promise<void>;
  delete(sourceId: string, targetId: string): Promise<void>;
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
  similarities: SimilarityStore;
  configs: ScheduleConfigStore;
  schedules: SchedulePlanStore;
  unavailabilities: PersonUnavailabilityStore;
}

export interface DatabaseDump {
  persons: Person[];
  keywords: Keyword[];
  similarities: SimilarityEdge[];
  configs: ScheduleConfig[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
}