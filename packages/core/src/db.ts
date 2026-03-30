import type {
  Keyword,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
  SimilarityEdge,
} from './types.js';

export interface PersonStore {
  get(id: string): Promise<Person | undefined>;
  getAll(): Promise<Person[]>;
  put(value: Person): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeywordStore {
  get(id: string): Promise<Keyword | undefined>;
  getAll(): Promise<Keyword[]>;
  put(value: Keyword): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SimilarityStore {
  get(sourceId: string, targetId: string): Promise<SimilarityEdge | undefined>;
  getAll(): Promise<SimilarityEdge[]>;
  put(value: SimilarityEdge): Promise<void>;
  delete(sourceId: string, targetId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ScheduleConfigStore {
  get(id: string): Promise<ScheduleConfig | undefined>;
  getAll(): Promise<ScheduleConfig[]>;
  put(value: ScheduleConfig): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SchedulePlanStore {
  get(id: string): Promise<SchedulePlan | undefined>;
  getAll(): Promise<SchedulePlan[]>;
  put(value: SchedulePlan): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PersonUnavailabilityStore {
  get(id: string): Promise<PersonUnavailability | undefined>;
  getAll(): Promise<PersonUnavailability[]>;
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