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
  SolverDiagnostics,
  ScheduleQualityReport,
} from '../types.js';
import {
  buildConstraintGuidance,
  buildCostContext,
  computeCostBreakdown,
  toScheduleMetrics,
  validateScheduleAssignments,
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
export { buildCostContext, buildConstraintGuidance, noOverlapForbidden, validateScheduleAssignments } from './constraints.js';
export { MUTATION_WEIGHTS, ANNEALING_CONFIG } from './annealing.js';
export { solveConstrained } from './constrained.js';

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
    case 'reciprocalPenalty': return `Same-session reciprocal pairs contribute ${value.toFixed(3)}.`;
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
    'reciprocalPenalty',
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

export function computeScheduleQuality(
  plan: SchedulePlan, input: SolverInput, historicalSessions: Session[] = [],
): ScheduleQualityReport {
  const all = [...historicalSessions, ...plan.sessions];
  const days = all.map(session => Date.parse(`${session.date}T00:00:00Z`) / 86400000);
  const ordered = [...days].sort((a, b) => a - b);
  const spacings = ordered.slice(1).map((day, index) => day - ordered[index]!).sort((a, b) => a - b);
  const nominal = spacings[Math.floor(spacings.length / 2)] ?? 7;
  const first = ordered.length ? ordered[0]! - nominal / 2 : 0;
  const last = ordered.length ? ordered[ordered.length - 1]! + nominal / 2 : 0;
  const span = Math.max(0, last - first);
  const ctx = buildCostContext(input);
  const guidance = buildConstraintGuidance(ctx);
  const weights = [...ctx.personKeywords.keys()].map(id => guidance.presenterWeights.get(id) ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const slots = all.reduce((sum, session) => sum + session.presentations.length, 0);
  const persons = [...ctx.personKeywords.keys()].map((personId, index) => {
    const dates = all.flatMap((session, sessionIndex) => session.presentations
      .filter(presentation => presentation.presenterId === personId).map(() => days[sessionIndex]!)).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((day, gapIndex) => day - dates[gapIndex]!);
    const targetCount = totalWeight > 0 ? slots * weights[index]! / totalWeight : 0;
    const targetGapDays = span / (targetCount + 1);
    const mean = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
    const variance = gaps.length ? gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length : 0;
    return {
      personId, presentations: dates.length, targetGapDays,
      minGapDays: gaps.length ? Math.min(...gaps) : null,
      maxGapDays: gaps.length ? Math.max(...gaps) : null,
      gapCoefficientOfVariation: gaps.length >= 2 && mean > 0 ? Math.sqrt(variance) / mean : null,
      shortGapRate: gaps.length ? gaps.filter(gap => gap < 0.75 * targetGapDays).length / gaps.length : null,
      firstWaitDays: dates.length ? dates[0]! - first : null,
      lastWaitDays: dates.length ? last - dates[dates.length - 1]! : null,
    };
  });
  let reciprocalPairs = 0;
  for (const session of all) {
    const pairs = new Set(session.presentations.flatMap(presentation => presentation.questionerIds.map(id => `${presentation.presenterId}|${id}`)));
    for (const pair of pairs) {
      const [a, b] = pair.split('|');
      if (a! < b! && pairs.has(`${b}|${a}`)) reciprocalPairs++;
    }
  }
  return { reciprocalPairs, hardViolations: validateScheduleAssignments(plan.sessions, input).length, persons };
}

// ---------------------------------------------------------------------------
// Public solvers
// ---------------------------------------------------------------------------

const solver = annealingSolver;

export function createSolverDiagnostics(): SolverDiagnostics {
  return { initialCost: 0, finalCost: 0, iterations: 0, accepted: 0,
    invalidNeighbors: 0, unchangedNeighbors: 0, durationMs: 0, restarts: 0 };
}

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
