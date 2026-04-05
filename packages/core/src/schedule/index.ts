/**
 * Public API entry points for the Labby scheduling solver.
 *
 * Tunable constants are re-exported so callers can adjust them without
 * reaching into internal modules:
 *
 *   import { COST_WEIGHTS, MUTATION_WEIGHTS, ANNEALING_CONFIG } from './schedule/index.js';
 *   COST_WEIGHTS.presenterLoad = 8;   // penalize load imbalance more
 *   MUTATION_WEIGHTS.sessionRebuild = 0.3; // more large-jump mutations
 *   ANNEALING_CONFIG.maxIter = 10_000;
 */

import type {
  MetricExplanation,
  SchedulePlan,
  ScheduleMetrics,
  Session,
  SolverInput,
  IncrementalSolverInput,
  ScheduleConfig,
  PersonUnavailability,
} from '../types.js';
import {
  buildCostContext,
  computeCostBreakdown,
  toScheduleMetrics,
} from './constraints.js';
import {
  buildRandomSchedule,
  simulatedAnnealing,
  ANNEALING_CONFIG,
} from './optimizer.js';

export { COST_WEIGHTS } from './constraints.js';
export { MUTATION_WEIGHTS, ANNEALING_CONFIG } from './optimizer.js';

// ---------------------------------------------------------------------------
// Date / ID utilities
// ---------------------------------------------------------------------------

/** Generate a UUID-like string (not cryptographically strong). */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Return all ISO dates in [startDate, endDate] that fall on the configured days of week. */
export function generateSessionDates(config: ScheduleConfig): string[] {
  const dates: string[] = [];
  const end = new Date(config.endDate + 'T00:00:00Z');
  const cur = new Date(config.startDate + 'T00:00:00Z');
  while (cur <= end) {
    if (config.daysOfWeek.includes(cur.getUTCDay())) dates.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Build a lookup: ISO date → Set of unavailable personIds for the given config. */
function buildUnavailMap(
  unavailabilities: PersonUnavailability[],
  configId: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const u of unavailabilities) {
    if (u.configId !== configId) continue;
    const [sy, sm, sd] = u.startDate.split('-').map(Number);
    const [ey, em, ed] = u.endDate.split('-').map(Number);
    const start = Date.UTC(sy, sm - 1, sd);
    const end = Date.UTC(ey, em - 1, ed);
    for (let t = start; t <= end; t += 86_400_000) {
      const d = new Date(t);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(u.personId);
    }
  }
  return map;
}

function replaySessionMutationDates(baseDates: string[], plan: SchedulePlan): string[] {
  const records = [...(plan.sessionMutations ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const dates = [...baseDates];
  for (const rec of records) {
    const idx = dates.findIndex(d => d === rec.date);
    if (rec.action === 'delete') {
      if (idx >= 0) dates.splice(idx, 1);
      continue;
    }
    if (!rec.insertedDate || idx < 0) continue;
    dates.splice(rec.position === 'before' ? idx : idx + 1, 0, rec.insertedDate);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function metricSummary(key: keyof ScheduleMetrics, value: number): string {
  switch (key) {
    case 'totalCost': return `Overall objective value: ${value.toFixed(3)} (lower is better).`;
    case 'uniformityPenalty': return `Presentation interval variance is ${value.toFixed(3)}.`;
    case 'questionerPenalty': return `Repeated questioner–presenter pairs contribute ${value.toFixed(3)}.`;
    case 'relevancePenalty': return `Similarity mismatch contributes ${value.toFixed(3)}.`;
    case 'presenterLoadPenalty': return `Presenter load imbalance variance is ${value.toFixed(3)}.`;
    case 'questionerLoadPenalty': return `Questioner load imbalance variance is ${value.toFixed(3)}.`;
    case 'totalRolePenalty': return `Overall role imbalance variance is ${value.toFixed(3)}.`;
    case 'invalidAssignmentPenalty': return `Hard assignment violations contribute ${value.toFixed(3)}.`;
    default: return `Constraint effects contribute ${value.toFixed(3)}.`;
  }
}

export function explainScheduleMetrics(metrics: ScheduleMetrics): MetricExplanation[] {
  const keys: Array<keyof ScheduleMetrics> = [
    'uniformityPenalty',
    'questionerPenalty',
    'relevancePenalty',
    'presenterLoadPenalty',
    'questionerLoadPenalty',
    'totalRolePenalty',
    'invalidAssignmentPenalty',
    'constraintPenalty',
    'totalCost',
  ];
  return keys.map(key => ({
    key,
    label: key,
    value: metrics[key],
    summary: metricSummary(key, metrics[key]),
  }));
}

export function computeScheduleMetrics(
  plan: SchedulePlan,
  input: SolverInput,
  historicalSessions: Session[] = [],
): ScheduleMetrics {
  const ctx = buildCostContext(input);
  return toScheduleMetrics(computeCostBreakdown(plan.sessions, ctx, historicalSessions));
}

// ---------------------------------------------------------------------------
// Public solvers
// ---------------------------------------------------------------------------

/** Generate a complete schedule from scratch. */
export function solveFull(input: SolverInput): SchedulePlan {
  const { config, unavailabilities = [] } = input;
  const ctx = buildCostContext(input);
  const personIds = [...ctx.personKeywords.keys()];
  const dates = generateSessionDates(config);
  const unavailMap = buildUnavailMap(unavailabilities, config.id);

  const initial = buildRandomSchedule(personIds, dates, config, ctx, [], unavailMap);
  const optimized = simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap);

  return {
    id: generateId(),
    createdAt: Date.now(),
    configId: config.id,
    sessions: optimized,
  };
}

/**
 * Re-schedule sessions from changeDate onward, minimizing divergence from the
 * previous plan via a Hamming penalty.
 */
export function solveIncremental(input: IncrementalSolverInput): SchedulePlan {
  const { config, previousPlan, changeDate, unavailabilities = [] } = input;

  const frozenSessions = previousPlan.sessions.filter(s => s.date < changeDate);
  const replayedDates = replaySessionMutationDates(generateSessionDates(config), previousPlan);
  const mutableDates = replayedDates.filter(d => d >= changeDate);

  const ctx = buildCostContext(input);
  const personIds = [...ctx.personKeywords.keys()];
  const unavailMap = buildUnavailMap(unavailabilities, config.id);
  const hammingRef = previousPlan.sessions.filter(s => s.date >= changeDate);

  const initial = buildRandomSchedule(personIds, mutableDates, config, ctx, frozenSessions, unavailMap);
  const optimized = simulatedAnnealing(
    initial, ctx, frozenSessions, config,
    hammingRef, ANNEALING_CONFIG.hammingWeight, unavailMap,
  );

  return {
    id: generateId(),
    createdAt: Date.now(),
    configId: config.id,
    sessions: [...frozenSessions, ...optimized],
  };
}