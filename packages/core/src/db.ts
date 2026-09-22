import type {
  EmailTask,
  Keyword,
  KeywordVector,
  RankingJudgment,
  Person,
  PersonTag,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
  SystemSettings,
} from './types.js';

// #region Pagination

export interface ListQuery {
  offset: number;
  limit: number;
  sortBy?: EntityListSortBy;
  sortDirection?: ListSortDirection;
}

export type EntityListSortBy = 'modifiedAt' | 'name' | 'notes';

export type ListSortDirection = 'asc' | 'desc';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// #endregion

// #region Entity stores

export interface PersonStore {
  get(id: string): Promise<Person | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<Person>>;
  put(value: Person): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PersonTagStore {
  get(id: string): Promise<PersonTag | undefined>;
  list(query: ListQuery): Promise<PaginatedResult<PersonTag>>;
  put(value: PersonTag): Promise<void>;
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

export interface SystemSettingsStore {
  get(): Promise<SystemSettings>;
  put(value: SystemSettings): Promise<void>;
}

// #endregion

// #region Similarity store

/** Persists a training result atomically: coordinates and judgments must agree. */
export interface SimilarityStore {
  getHistory(): Promise<RankingJudgment[]>;
  /** Removes a mistaken constraint; existing coordinates are retained. */
  forgetJudgment(id: string): Promise<void>;
  commit(vectors: KeywordVector[], history: RankingJudgment[]): Promise<void>;
}

// #endregion

// #region Related entity reads

export interface ScheduleForeignKeyBundle {
  persons: Person[];
  personTags: PersonTag[];
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
  personTags: PersonTag[];
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

// #endregion

// #region Graph snapshot

/** A complete current record; null keyword is a deletion tombstone. */
export interface GraphRecord {
  id: string;
  keyword: Keyword | null;
  vector: KeywordVector | null;
}
export interface GraphQuery {
  cursor?: string;
  since?: string;
  limit?: number;
}
export interface GraphPage {
  items: GraphRecord[];
  nextCursor: string | null;
  /** Advance only after the last page of a batch. */
  checkpoint: string | null;
  reset: boolean;
}
export interface GraphSnapshotEdge {
  sourceId: string;
  targetId: string;
  weight: number;
}
export interface GraphStore {
  list(query?: GraphQuery): Promise<GraphPage>;
}

// #endregion

// #region Database and backup

export interface LabbyDB {
  similarity: SimilarityStore;
  persons: PersonStore;
  personTags: PersonTagStore;
  keywords: KeywordStore;
  keywordVectors: KeywordVectorStore;
  configs: ScheduleConfigStore;
  constraints: ScheduleConstraintStore;
  schedules: SchedulePlanStore;
  unavailabilities: PersonUnavailabilityStore;
  emailTasks: EmailTaskStore;
  systemSettings: SystemSettingsStore;
  foreignKeys: ForeignKeyStore;
  graph: GraphStore;
}

export interface DatabaseDump {
  rankingHistory: RankingJudgment[];
  persons: Person[];
  personTags: PersonTag[];
  keywords: Keyword[];
  keywordVectors: KeywordVector[];
  configs: ScheduleConfig[];
  constraints: ScheduleConstraint[];
  schedules: SchedulePlan[];
  unavailabilities: PersonUnavailability[];
  emailTasks: EmailTask[];
  systemSettings?: SystemSettings;
}

// #endregion
