/** Core entity and scheduling type definitions for Labby. */

/** Stable UUID used for the singleton settings row. */
export const SYSTEM_SETTINGS_ID = '00000000-0000-4000-8000-000000000001';

/** Base multilingual entity shared by all domain objects. */
export interface BaseEntity {
  id: string; // UUID
  name: string; // default display name
  names: Record<string, string>; // multilingual name map, e.g. { zh: "小明", en: "Ming" }
  metadata: Record<string, unknown>; // arbitrary extension metadata
  disabled?: boolean; // when true, excluded from scheduling
  notes?: string; // free-form notes
}

/** A seminar participant. */
export interface Person extends BaseEntity {
  keywordIds: string[]; // associated keyword IDs (max 10)
  tagIds?: string[]; // associated person-label IDs
  modifiedAt?: number;
}

/** A user-managed colored label that can be attached to people. */
export interface PersonTag {
  id: string;
  name: string;
  names: Record<string, string>;
  color: string; // CSS hex color (#RRGGBB)
  notes?: string;
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

/** Persistent keyword vector state owned by the shared embedding engine. */
export interface KeywordVector {
  keywordId: string;
  /** Spatial Lorentz coordinates followed by Euclidean coordinates. */
  embedding: number[];
  geometry: ProductGeometry;
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
  reciprocalPairPreference?: 'forbid' | 'discourage' | 'neutral' | 'encourage';
  /** Optional tuning of real consecutive role gaps. Missing values use solver defaults. */
  gapBalance?: {
    presenter?: Partial<GapBalancePolicy>;
    questioner?: Partial<GapBalancePolicy>;
  };
  /** Independent, per-schedule controls for initial questioner assignment and targeted repair. */
  questionerOptimization?: {
    assignment?: Partial<QuestionerAssignmentPolicy>;
    repair?: Partial<QuestionerRepairPolicy>;
  };
  /** Per-schedule objective weights; omitted fields use COST_WEIGHTS. */
  costWeights?: Partial<ScheduleCostWeights>;
  startDate: string; // ISO date, first possible session
  endDate: string; // ISO date, last possible session
  /**
   * Optional cron expression for scheduled email notifications,
   * e.g. "0 9 * * 1" for Monday 09:00.
   */
  notifyAt?: string;
  /** Timezone for the notifyAt cron expression, e.g. "Asia/Tokyo". Defaults to UTC. */
  notifyTimezone?: string;
  /** IANA timezone for this schedule config. Defaults to system/environment timezone when omitted. */
  timezone?: string;
  /** Arbitrary extension metadata. */
  metadata?: Record<string, unknown>;
  modifiedAt?: number;
}

export interface QuestionerAssignmentPolicy {
  /** Chance to prefer a presenter/questioner pair used least often so far. */
  noveltyChance: number;
  /** Chance to prefer the least-loaded eligible questioner so far. */
  balanceChance: number;
}

export interface QuestionerRepairPolicy {
  /** Maximum targeted replacement/swap attempts after annealing. */
  iterations: number;
  /** Extra emphasis on repeated directed pairs during repair. */
  pairWeight: number;
  /** Extra emphasis on count imbalance during repair. */
  countWeight: number;
}

export interface QuestionerOptimizationPolicy {
  assignment: QuestionerAssignmentPolicy;
  repair: QuestionerRepairPolicy;
}

export interface ScheduleCostWeights {
  uniformity: number;
  reciprocal: number;
  questionerPair: number;
  relevance: number;
  presenterLoad: number;
  questionerCount: number;
  questionerGap: number;
  totalRole: number;
  invalidAssignment: number;
  constraint: number;
}

export interface GapBalancePolicy {
  /** Gap below this fraction of a person's own target receives an extra penalty. */
  shortGapRatio: number;
  /** Extra squared penalty for each gap below shortGapRatio. */
  shortGapWeight: number;
  /** Penalty for variation among actual consecutive gaps. */
  spreadWeight: number;
}

/** User-configurable scheduled email task. */
export interface EmailTask {
  id: string;
  configId: string;
  disabled?: boolean;
  notes?: string;
  /** 0=Sun..6=Sat */
  daysOfWeek: number[];
  /** Daily local send time in HH:mm for the selected timezone. */
  sendTime?: string;
  /** Explicit IANA timezone, e.g. Asia/Shanghai. Falls back through schedule/system/environment when omitted. */
  timezone?: string;
  emails: string[];
  /** 0 means unlimited sends for each recipient. */
  recentTimes: number;
  /** Optional template source for the human-friendly sender display name. */
  senderNameTemplate?: string;
  /** Optional subject template source text for email title rendering. */
  subjectTemplate?: string;
  /** Template source text, parsed by the template module. */
  templateText: string;
  /** Per-recipient successful send count. */
  sentCounts?: Record<string, number>;
  /** Last execution timestamp in epoch ms. */
  lastRunAt?: number;
  /** Skip exactly one upcoming scheduled run, then auto-reset to false. */
  skipNextRun?: boolean;
  /** Last time a scheduled run was skipped due to skipNextRun. */
  lastSkippedAt?: number;
  metadata?: Record<string, unknown>;
  modifiedAt?: number;
}

/** Global system settings stored as a singleton record. */
export interface SystemSettings {
  id?: string;
  /** IANA timezone. Omit to use the environment timezone. */
  timezone?: string;
  metadata?: Record<string, unknown>;
  modifiedAt?: number;
}

export type TemplateFormat = 'markdown' | 'html';

export interface ScheduleMetrics {
  uniformityPenalty: number;
  reciprocalPenalty: number;
  questionerPenalty: number;
  relevancePenalty: number;
  presenterLoadPenalty: number;
  questionerCountPenalty: number;
  questionerGapPenalty: number;
  totalRolePenalty: number;
  invalidAssignmentPenalty: number;
  constraintPenalty: number;
  totalCost: number;
}

export interface SolverDiagnostics {
  initialCost: number;
  finalCost: number;
  iterations: number;
  accepted: number;
  invalidNeighbors: number;
  unchangedNeighbors: number;
  durationMs: number;
  restarts: number;
}

export interface PersonScheduleQuality {
  personId: string;
  presentations: number;
  targetGapDays: number;
  minGapDays: number | null;
  maxGapDays: number | null;
  gapCoefficientOfVariation: number | null;
  shortGapRate: number | null;
  firstWaitDays: number | null;
  lastWaitDays: number | null;
}

export interface ScheduleQualityReport {
  reciprocalPairs: number;
  hardViolations: number;
  shortGapRatio: number;
  persons: PersonScheduleQuality[];
}

export interface MetricExplanation {
  key: keyof ScheduleMetrics;
  label: string;
  value: number;
  summary: string;
}

export interface ScheduleMutationInput {
  previousPlan: SchedulePlan;
  /** Session date to insert or delete. */
  date: string;
  action: 'insert' | 'delete';
  tactic?: 'shift' | 'keep';
}

/** Immutable snapshot of a generated schedule. */
export interface SchedulePlan {
  id: string;
  createdAt: number; // epoch ms – used for timeline history
  modifiedAt?: number;
  configId: string;
  sessions: Session[];
  solverDiagnostics?: SolverDiagnostics;
  notes?: string; // user-written notes for this history entry
  sessionMutations?: ScheduleSessionMutationRecord[];
  /** Optional per-date marker used by UI to distinguish mutated sessions from naturally generated sessions. */
  sessionDateMeta?: Record<string, {
    action: 'insert' | 'delete';
    createdAt: number;
  }>;
}

/** Mutation event stored by date so it can be replayed across config date changes. */
export interface ScheduleSessionMutationRecord {
  date: string;
  action: 'insert' | 'delete';
  createdAt: number;
}

/** Inclusive calendar-date range when selected people, tag members, or everyone is unavailable. */
export interface PersonUnavailability {
  id: string;
  personIds: string[];
  tagIds: string[];
  /** A whole-group closure cancels generated sessions on these dates. */
  allPeople: boolean;
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
  config: ScheduleConfig;
  persons: Person[];
  /** Flat similarity map: key = `${sourceId}|${targetId}`, value = weight */
  similarities: SimilarityLookup;
  mutations?: ScheduleSessionMutationRecord[];
  /** Optional: persons unavailable on certain date ranges */
  unavailabilities?: PersonUnavailability[];
  /** Optional: additional scheduling constraints */
  constraints?: ScheduleConstraint[];
  /** Filled by the solver when a caller requests search diagnostics. */
  diagnostics?: SolverDiagnostics;
}

/** Input bundle for the incremental solver. */
export interface IncrementalSolverInput extends SolverInput {
  sessions: Session[]; // current sessions to be mutated
  index?: number; // session index to change (0-based)
  changeDate?: string; // ISO date – sessions on or after this date are re-scheduled
  mode?: IncrementalSolveMode; // full = presenters+questioners, questioners-only = keep presenters fixed
  useHamming?: boolean; // whether to apply Hamming penalty to changes from previousPlan
}

export type IncrementalSolveMode = 'full' | 'questioners-only';

/** A fixed person id or an Auto slot to be filled by the constrained solver. */
export type ScheduleTemplatePersonId = string | null;

export interface ScheduleTemplatePresentation {
  presenterId: ScheduleTemplatePersonId;
  questionerIds: ScheduleTemplatePersonId[];
}

export interface ScheduleTemplateSession {
  date: string;
  presentations: ScheduleTemplatePresentation[];
}

/** Solver input used by the direct schedule editor. Null slots are optimized; string ids remain fixed. */
export interface ConstrainedSolverInput extends SolverInput {
  template: ScheduleTemplateSession[];
  historicalSessions?: Session[];
}

export interface ProductGeometry {
  hyperbolicDimensions: number;
  euclideanDimensions: number;
}

export interface TrainingOptions {
  learningRate?: number;
  maxIterations?: number;
  historyWeight?: number;
  driftWeight?: number;
}

export interface RankingQuery {
  key: string;
  anchorId: string;
  candidateIds: string[];
}

/** Ordered near-to-far groups; members within a group are tied. Omitted items are unknown. */
export interface RankingJudgment {
  id: string;
  anchorId: string;
  groups: string[][];
  confidence: number;
  createdAt: number;
}

export interface TrainingResult {
  accepted: boolean;
  loss: number;
  updatedVectors: KeywordVector[];
  history: RankingJudgment[];
  conflicts: string[];
  maxDistanceDrift: number;
}

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
  disabled?: boolean;
  /** Constraint applies to any person whose ID is in this set. */
  personIds: string[];
  tagIds: string[];
  /** When supplied, only pairs crossing the two target groups are forbidden. */
  otherPersonIds?: string[];
  otherTagIds?: string[];
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
  disabled?: boolean;
  /** Members of the group whose co-occurrence should be boosted. */
  personIds: string[];
  tagIds: string[];
  /** When supplied, boost only pairs crossing the two target groups. */
  otherPersonIds?: string[];
  otherTagIds?: string[];
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
  disabled?: boolean;
  personIds: string[];
  tagIds: string[];
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
  solveFull(input: SolverInput): Session[];
  solveIncremental(input: IncrementalSolverInput): Session[];
}
