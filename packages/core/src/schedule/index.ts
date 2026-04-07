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
} from '../types.js';
import {
  buildConstraintGuidance,
  buildCostContext,
  computeCostBreakdown,
  toScheduleMetrics,
} from './constraints.js';
import {
  annealingSolver,
} from './annealing.js';

export {
  replaySessionMutations,
  mergeMutationRecords,
  mutateSessions,
  mutatePresentations,
} from './mutation.js';

export { COST_WEIGHTS } from './constraints.js';
export { MUTATION_WEIGHTS, ANNEALING_CONFIG } from './annealing.js';

// ---------------------------------------------------------------------------
// Date / ID utilities
// ---------------------------------------------------------------------------
export { generateId, generateSessionDates } from './utils.js';
// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function metricSummary(key: keyof ScheduleMetrics, value: number): string {
  switch (key) {
    case 'totalCost': return `Overall objective value: ${value.toFixed(3)} (lower is better).`;
    case 'uniformityPenalty': return `Presenter/questioner interval non-uniformity contributes ${value.toFixed(3)}.`;
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
  const guidance = buildConstraintGuidance(ctx);
  return toScheduleMetrics(computeCostBreakdown(plan.sessions, ctx, guidance, historicalSessions));
}

// ---------------------------------------------------------------------------
// Public solvers
// ---------------------------------------------------------------------------

const solver = annealingSolver;

/** Generate a complete schedule from scratch. */
export function solveFull(input: SolverInput): Session[] {
  return solver.solveFull(input);
}

/**
 * Re-schedule sessions from changeDate onward, minimizing divergence from the
 * previous plan via a Hamming penalty.
 */
export function solveIncremental(input: IncrementalSolverInput): Session[] {
  return solver.solveIncremental(input);
}