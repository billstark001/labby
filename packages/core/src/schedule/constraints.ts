/**
 * Cost function and constraint evaluation for the scheduling solver.
 *
 * All penalty weights are configurable by editing COST_WEIGHTS.
 */

import type {
  ScheduleMetrics,
  Session,
  SolverInput,
  ScheduleConstraint,
  SimilarityLookup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Configurable cost weights
// ---------------------------------------------------------------------------

/**
 * Weight applied to each term of the objective function.
 * Increase a weight to penalize that term more heavily during optimization.
 */
export const COST_WEIGHTS = {
  /** Variance of each person's presentation gaps – encourages uniform spacing. */
  uniformity: 4,
  /** Exponential penalty for repeated (questioner → presenter) pairs. */
  questioner: 2,
  /** |sim(questioner, presenter) − r| summed over all pairs. */
  relevance: 1,
  /** Variance of per-person presenter appearance counts. */
  presenterLoad: 5,
  /** Variance of per-person questioner appearance counts. */
  questionerLoad: 5,
  /** Variance of each person's total role count (presenter + questioner). */
  totalRole: 2,
  /** Hard penalty for self-questioning or duplicate questioners within one presentation. */
  invalidAssignment: 1,
  /** Multiplier on the aggregate penalty returned by user-defined constraints. */
  constraint: 2,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostContext {
  personKeywords: Map<string, string[]>;
  similarities: Map<string, number> | SimilarityLookup;
  /** Target similarity radius r. */
  r: number;
  constraints?: ScheduleConstraint[];
}

export interface CostBreakdown {
  uniformityPenalty: number;
  questionerPenalty: number;
  relevancePenalty: number;
  presenterLoadPenalty: number;
  questionerLoadPenalty: number;
  totalRolePenalty: number;
  invalidAssignmentPenalty: number;
  constraintPenalty: number;
}

// ---------------------------------------------------------------------------
// Shared helpers (also consumed by optimizer.ts)
// ---------------------------------------------------------------------------

export function incrementCount(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function varianceForPeople(counts: Map<string, number>, personIds: string[]): number {
  if (personIds.length === 0) return 0;
  const values = personIds.map(id => counts.get(id) ?? 0);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

export function personSimilarity(
  aKeywords: string[],
  bKeywords: string[],
  sim: Map<string, number> | SimilarityLookup,
): number {
  if (aKeywords.length === 0 || bKeywords.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const a of aKeywords) {
    for (const b of bKeywords) {
      if (a === b) { total += 1; count++; continue; }
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const w = sim instanceof Map ? sim.get(key) : sim.getPairSimilarity(a, b);
      if (w !== undefined) { total += w; count++; }
    }
  }
  return count === 0 ? 0 : total / count;
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

export function computeCostBreakdown(
  sessions: Session[],
  ctx: CostContext,
  historicalSessions: Session[] = [],
): CostBreakdown {
  const allSessions = [...historicalSessions, ...sessions];
  const personIds = [...ctx.personKeywords.keys()];

  const presentationIndices = new Map<string, number[]>();
  const presenterCounts = new Map<string, number>();
  const questionerCounts = new Map<string, number>();
  const totalRoleCounts = new Map<string, number>();

  allSessions.forEach((sess, idx) => {
    for (const p of sess.presentations) {
      const arr = presentationIndices.get(p.presenterId) ?? [];
      arr.push(idx);
      presentationIndices.set(p.presenterId, arr);
      incrementCount(presenterCounts, p.presenterId);
      incrementCount(totalRoleCounts, p.presenterId);
    }
  });

  // 1. Uniformity – variance of presentation gaps per person
  let uniformityPenalty = 0;
  for (const indices of presentationIndices.values()) {
    if (indices.length < 2) continue;
    const gaps = indices.slice(1).map((v, i) => v - indices[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    uniformityPenalty += gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  }

  // 2. Questioner frequency + hard invalidity
  const questionerFreq = new Map<string, number>();
  let questionerPenalty = 0;
  let invalidAssignmentPenalty = 0;
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      const seen = new Set<string>();
      for (const q of pres.questionerIds) {
        incrementCount(questionerCounts, q);
        incrementCount(totalRoleCounts, q);
        if (q === pres.presenterId) invalidAssignmentPenalty += 1000;
        if (seen.has(q)) invalidAssignmentPenalty += 250;
        seen.add(q);
        const key = `${q}→${pres.presenterId}`;
        const freq = (questionerFreq.get(key) ?? 0) + 1;
        questionerFreq.set(key, freq);
        if (freq > 1) questionerPenalty += Math.exp(freq - 1) - 1;
      }
    }
  }

  // 3. Domain relevance – |sim(q, presenter) − r|
  let relevancePenalty = 0;
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      const pk = ctx.personKeywords.get(pres.presenterId) ?? [];
      for (const q of pres.questionerIds) {
        relevancePenalty += Math.abs(
          personSimilarity(pk, ctx.personKeywords.get(q) ?? [], ctx.similarities) - ctx.r,
        );
      }
    }
  }

  // 4. Load balance
  const presenterLoadPenalty = varianceForPeople(presenterCounts, personIds);
  const questionerLoadPenalty = varianceForPeople(questionerCounts, personIds);
  const totalRolePenalty = varianceForPeople(totalRoleCounts, personIds);

  // 5. User-defined constraints
  let constraintPenalty = 0;
  for (const constraint of ctx.constraints ?? []) {
    if (constraint.type === 'no-overlap') {
      const group = new Set(constraint.personIds);
      const weight = constraint.weight ?? 5.0;
      for (const sess of allSessions) {
        for (const pres of sess.presentations) {
          if (!group.has(pres.presenterId)) continue;
          for (const q of pres.questionerIds) {
            if (group.has(q)) constraintPenalty += weight;
          }
        }
      }
    } else if (constraint.type === 'affinity-boost') {
      const group = new Set(constraint.personIds);
      const boost = constraint.boost ?? 2.0;
      for (const sess of allSessions) {
        for (const pres of sess.presentations) {
          if (!group.has(pres.presenterId)) continue;
          for (const q of pres.questionerIds) {
            if (group.has(q)) constraintPenalty -= (boost - 1) * 0.5;
          }
        }
      }
    } else if (constraint.type === 'frequency-multiplier') {
      const roleScope = constraint.roleScope ?? 'presenter';
      const baseline = Number.isFinite(constraint.baseline) ? Math.max(0, constraint.baseline) : 0;
      const multiplier = Number.isFinite(constraint.multiplier) ? constraint.multiplier : 1;
      const target = Math.max(0, baseline * multiplier);
      const weight = constraint.weight ?? 1.0;
      for (const id of constraint.personIds) {
        const pc = presenterCounts.get(id) ?? 0;
        const qc = questionerCounts.get(id) ?? 0;
        const actual = roleScope === 'both' ? pc + qc : roleScope === 'questioner' ? qc : pc;
        constraintPenalty += Math.abs(actual - target) * weight;
      }
    }
  }

  return {
    uniformityPenalty,
    questionerPenalty,
    relevancePenalty,
    presenterLoadPenalty,
    questionerLoadPenalty,
    totalRolePenalty,
    invalidAssignmentPenalty,
    constraintPenalty,
  };
}

export function weightedTotalCost(breakdown: CostBreakdown): number {
  return (
    breakdown.uniformityPenalty * COST_WEIGHTS.uniformity
    + breakdown.questionerPenalty * COST_WEIGHTS.questioner
    + breakdown.relevancePenalty * COST_WEIGHTS.relevance
    + breakdown.presenterLoadPenalty * COST_WEIGHTS.presenterLoad
    + breakdown.questionerLoadPenalty * COST_WEIGHTS.questionerLoad
    + breakdown.totalRolePenalty * COST_WEIGHTS.totalRole
    + breakdown.invalidAssignmentPenalty * COST_WEIGHTS.invalidAssignment
    + breakdown.constraintPenalty * COST_WEIGHTS.constraint
  );
}

export function toScheduleMetrics(breakdown: CostBreakdown): ScheduleMetrics {
  return { ...breakdown, totalCost: weightedTotalCost(breakdown) };
}

export function buildCostContext(input: SolverInput): CostContext {
  const active = input.persons.filter(p => !p.disabled);
  return {
    personKeywords: new Map(active.map(p => [p.id, p.keywordIds])),
    similarities: input.similarities,
    r: input.config.targetSimilarityRadius,
    constraints: input.constraints ?? [],
  };
}

export function computeCost(
  sessions: Session[],
  ctx: CostContext,
  historicalSessions: Session[] = [],
): number {
  return weightedTotalCost(computeCostBreakdown(sessions, ctx, historicalSessions));
}