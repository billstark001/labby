import type {
  EmailTask,
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
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

export interface ScheduleConstraintStore {
  get(id: string): Promise<ScheduleConstraint | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<ScheduleConstraint>>;
  put(value: ScheduleConstraint): Promise<void>;
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

export interface EmailTaskStore {
  get(id: string): Promise<EmailTask | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<EmailTask>>;
  put(value: EmailTask): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ScheduleForeignKeyBundle {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
}

export interface ScheduleForeignKeyQuery {
  configIds: string[];
}

export interface PersonForeignKeyBundle {
  keywords: Keyword[];
  schedules: SchedulePlan[];
  constraints: ScheduleConstraint[];
  unavailabilities: PersonUnavailability[];
}

export interface PersonForeignKeyQuery {
  personIds: string[];
}

export interface KeywordForeignKeyBundle {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
}

export interface KeywordForeignKeyQuery {
  keywordIds: string[];
}

export interface ForeignKeyStore {
  readForSchedule(query: ScheduleForeignKeyQuery): Promise<ScheduleForeignKeyBundle>;
  readForPerson(query: PersonForeignKeyQuery): Promise<PersonForeignKeyBundle>;
  readForKeyword(query: KeywordForeignKeyQuery): Promise<KeywordForeignKeyBundle>;
}

export interface LabbyDB {
  persons: PersonStore;
  keywords: KeywordStore;
  keywordVectors: KeywordVectorStore;
  configs: ScheduleConfigStore;
  constraints: ScheduleConstraintStore;
  schedules: SchedulePlanStore;
  unavailabilities: PersonUnavailabilityStore;
  emailTasks: EmailTaskStore;
  foreignKeys: ForeignKeyStore;
}

export interface DatabaseDump {
  persons: Person[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
  emailTasks: EmailTask[];
}