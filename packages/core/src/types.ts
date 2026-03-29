/** Core entity and scheduling type definitions for Labby. */

/** Base multilingual entity shared by all domain objects. */
export interface BaseEntity {
  id: string; // UUID v4 or NanoID
  name: string; // default display name
  names: Record<string, string>; // multilingual name map, e.g. { zh: "小明", en: "Ming" }
  metadata: Record<string, unknown>; // arbitrary extension metadata
}

/** A seminar participant. */
export interface Person extends BaseEntity {
  keywordIds: string[]; // associated keyword IDs
}

/** A research keyword / topic tag. */
export interface Keyword extends BaseEntity {
  // metadata may cache D3 layout coordinates, e.g. { x: 0.4, y: 0.7 }
}

/** Directed similarity edge between two keywords. */
export interface SimilarityEdge {
  sourceId: string;
  targetId: string;
  weight: number; // 0–1 (higher = more similar)
}

/** Weekly scheduling rule configuration. */
export interface ScheduleConfig {
  id: string;
  daysOfWeek: number[]; // 0=Sun … 6=Sat, e.g. [5] for Friday
  timeRange: [string, string]; // e.g. ["14:00", "16:00"]
  presentersPerSession: number; // default 3
  questionersPerPresenter: number; // default 2
  targetSimilarityRadius: number; // desired similarity r ≈ 0.5
  startDate: string; // ISO date, first possible session
  endDate: string; // ISO date, last possible session
}

/** Immutable snapshot of a generated schedule. */
export interface SchedulePlan {
  id: string;
  createdAt: number; // epoch ms – used for timeline history
  configId: string;
  sessions: Session[];
}

/** One seminar session on a calendar date. */
export interface Session {
  date: string; // ISO date YYYY-MM-DD
  presentations: Presentation[];
}

/** A single presentation slot: one presenter and their assigned questioners. */
export interface Presentation {
  presenterId: string;
  questionerIds: string[];
}

/** Input bundle for the full solver. */
export interface SolverInput {
  persons: Person[];
  /** Flat similarity map: key = `${sourceId}|${targetId}`, value = weight */
  similarities: Map<string, number>;
  config: ScheduleConfig;
}

/** Input bundle for the incremental solver. */
export interface IncrementalSolverInput extends SolverInput {
  previousPlan: SchedulePlan;
  changeDate: string; // ISO date – sessions on or after this date are re-scheduled
}

/** Triplet comparison query presented to the user. */
export interface TripletQuery {
  anchorId: string; // keyword A
  positiveId: string; // keyword C ("A is closer to C …")
  negativeId: string; // keyword B ("… than to B")
}
