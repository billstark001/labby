/** Core entity and scheduling type definitions for Labby. */

/** Base multilingual entity shared by all domain objects. */
export interface BaseEntity {
  id: string; // UUID v4 or NanoID
  name: string; // default display name
  names: Record<string, string>; // multilingual name map, e.g. { zh: "小明", en: "Ming" }
  metadata: Record<string, unknown>; // arbitrary extension metadata
  disabled?: boolean; // when true, excluded from scheduling
  notes?: string; // free-form notes
}

/** A seminar participant. */
export interface Person extends BaseEntity {
  keywordIds: string[]; // associated keyword IDs (max 10)
  modifiedAt?: number;
}

/** A research keyword / topic tag. */
export interface Keyword extends BaseEntity {
  // metadata may cache D3 layout coordinates, e.g. { x: 0.4, y: 0.7 }
  modifiedAt?: number;
}

/** Directed similarity edge between two keywords. */
export interface SimilarityEdge {
  sourceId: string;
  targetId: string;
  weight: number; // 0–1 (higher = more similar)
}

/** On-demand keyword similarity lookup, used to avoid eagerly building O(N^2) maps. */
export interface SimilarityLookup {
  getPairSimilarity(leftKeywordId: string, rightKeywordId: string): number | undefined;
}

/** Persistent keyword vector state owned by the Rust embedding engine. */
export interface KeywordVector {
  keywordId: string;
  vector64: number[];
  x: number;
  y: number;
  updatedAt: number;
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
  /**
   * Optional cron expression for scheduled email notifications,
   * e.g. "0 9 * * 1" for Monday 09:00.
   */
  notifyAt?: string;
  /** Timezone for the notifyAt cron expression, e.g. "Asia/Tokyo". Defaults to UTC. */
  notifyTimezone?: string;
  /** Arbitrary extension metadata. */
  metadata?: Record<string, unknown>;
  modifiedAt?: number;
}

/** User-configurable scheduled email task. */
export interface EmailTask {
  id: string;
  configId: string;
  /** 0=Sun..6=Sat */
  daysOfWeek: number[];
  emails: string[];
  /** 0 means unlimited sends for each recipient. */
  recentTimes: number;
  /** Template source text, parsed by the template module. */
  templateText: string;
  /** Per-recipient successful send count. */
  sentCounts?: Record<string, number>;
  /** Last execution timestamp in epoch ms. */
  lastRunAt?: number;
  metadata?: Record<string, unknown>;
  modifiedAt?: number;
}

export type TemplateFormat = 'markdown' | 'html';

export interface TemplateRenderError {
  expression: string;
  message: string;
  start: number;
  end: number;
  kind: 'lex' | 'parse' | 'eval' | 'template';
}

export interface TemplateRenderResult {
  output: string;
  errors: TemplateRenderError[];
}

export interface ScheduleMetrics {
  uniformityPenalty: number;
  questionerPenalty: number;
  relevancePenalty: number;
  presenterLoadPenalty: number;
  questionerLoadPenalty: number;
  totalRolePenalty: number;
  invalidAssignmentPenalty: number;
  constraintPenalty: number;
  totalCost: number;
}

export interface MetricExplanation {
  key: keyof ScheduleMetrics;
  label: string;
  value: number;
  summary: string;
}

export interface ScheduleMutationInput {
  previousPlan: SchedulePlan;
  /** Target session date in the previous plan. */
  date: string;
  action: 'insert' | 'delete';
  insertedDate?: string;
  position?: 'before' | 'after';
}

/** Immutable snapshot of a generated schedule. */
export interface SchedulePlan {
  id: string;
  createdAt: number; // epoch ms – used for timeline history
  modifiedAt?: number;
  configId: string;
  sessions: Session[];
  notes?: string; // user-written notes for this history entry
  sessionMutations?: ScheduleSessionMutationRecord[];
}

/** Mutation event stored by date so it can be replayed across config date changes. */
export interface ScheduleSessionMutationRecord {
  date: string;
  action: 'insert' | 'delete';
  insertedDate?: string;
  position?: 'before' | 'after';
  createdAt: number;
}

/** A period when a person is unavailable (cannot present or question). */
export interface PersonUnavailability {
  id: string;
  personId: string;
  configId: string;
  startDate: string; // ISO date
  endDate: string;   // ISO date (inclusive)
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
  similarities: Map<string, number> | SimilarityLookup;
  config: ScheduleConfig;
  /** Optional: persons unavailable on certain date ranges */
  unavailabilities?: PersonUnavailability[];
  /** Optional: additional scheduling constraints */
  constraints?: ScheduleConstraint[];
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

/** Iterative optimizer options for embedding updates. */
export interface IterativeUpdateOptions {
  learningRate?: number;
  minIters?: number;
  maxIters?: number;
  stabilityWindow?: number;
  stabilityTolerance?: number;
}

/** Pair distance supervision query (2 points). */
export interface PairSupervisionQuery {
  kind: 'pair';
  leftId: string;
  rightId: string;
  targetDistance: number;
  updateOptions?: IterativeUpdateOptions;
}

/**
 * Ranked supervision query (arbitrary points > 2).
 *
 * `orderedIds` are interpreted as "closer to farther from anchor".
 * Example: [p1, p2, p3] compiles to constraints
 * (anchor, p1, p2) and (anchor, p2, p3).
 */
export interface RankedSupervisionQuery {
  kind: 'ranked';
  anchorId: string;
  orderedIds: string[];
  margin?: number;
  updateOptions?: IterativeUpdateOptions;
}

/** Unified supervision query for similarity training. */
export type SupervisionQuery = PairSupervisionQuery | RankedSupervisionQuery;

// ---------------------------------------------------------------------------
// Schedule constraints
// ---------------------------------------------------------------------------

/**
 * Prevent members of a group from simultaneously being presenter and questioner
 * in the same presentation (e.g., colleagues who are too familiar with each other
 * or too unfamiliar with the research topic).
 */
export interface NoOverlapConstraint {
  id: string;
  /** Optional config scope. Omit or set empty string to apply to all configs. */
  configId?: string;
  type: 'no-overlap';
  /** Constraint applies to any person whose ID is in this set. */
  personIds: string[];
  /**
   * Penalty weight applied when the constraint is violated.
   * Defaults to 5.0.
   */
  weight?: number;
  modifiedAt?: number;
}

/**
 * Boost the probability that members of a group appear together
 * (as presenter + questioner) in the same presentation.
 * Useful when a group benefits from cross-exposure or shared research topics.
 */
export interface AffinityBoostConstraint {
  id: string;
  /** Optional config scope. Omit or set empty string to apply to all configs. */
  configId?: string;
  type: 'affinity-boost';
  /** Members of the group whose co-occurrence should be boosted. */
  personIds: string[];
  /**
   * Affinity multiplier applied to the similarity score between group members.
   * Values > 1 encourage pairing; values < 1 discourage it.
   * Defaults to 2.0.
   */
  boost?: number;
  modifiedAt?: number;
}

/**
 * Adjust expected appearance frequency for selected persons by multiplier k.
 * k > 1 encourages more appearances, k < 1 discourages them.
 */
export interface FrequencyMultiplierConstraint {
  id: string;
  /** Optional config scope. Omit or set empty string to apply to all configs. */
  configId?: string;
  type: 'frequency-multiplier';
  personIds: string[];
  baseline: number;
  multiplier: number;
  roleScope?: 'presenter' | 'questioner' | 'both';
  weight?: number;
  modifiedAt?: number;
}

/** Union of all supported schedule constraints. */
export type ScheduleConstraint =
  | NoOverlapConstraint
  | AffinityBoostConstraint
  | FrequencyMultiplierConstraint;


export interface ScheduleSolver {
  solveFull(input: SolverInput): SchedulePlan;
  solveIncremental(input: IncrementalSolverInput): SchedulePlan;
}