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
  /** Interval-uniformity penalty for presenter/questioner appearances. */
  uniformity: 10,
  /** Exponential penalty for repeated (questioner → presenter) pairs. */
  questioner: 1,
  /** |sim(questioner, presenter) − r| summed over all pairs. */
  relevance: 0.8,
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
  similarities: SimilarityLookup;
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

interface AffinityGuide {
  group: Set<string>;
  boost: number;
}

interface FrequencyGuide {
  personIds: Set<string>;
  baseline: number;
  multiplier: number;
  roleScope: 'presenter' | 'questioner' | 'both';
  weight: number;
}

interface ConstraintGuidance {
  affinity: AffinityGuide[];
  frequency: FrequencyGuide[];
}

function buildConstraintGuidance(ctx: CostContext): ConstraintGuidance {
  const guidance: ConstraintGuidance = {
    affinity: [],
    frequency: [],
  };

  for (const c of ctx.constraints ?? []) {
    if (c.type === 'affinity-boost') {
      guidance.affinity.push({
        group: new Set(c.personIds),
        boost: c.boost ?? 2,
      });
      continue;
    }

    if (c.type === 'frequency-multiplier') {
      const baseline = Number.isFinite(c.baseline) ? Math.max(0, c.baseline) : 0;
      const multiplier = Number.isFinite(c.multiplier) ? c.multiplier : 1;
      guidance.frequency.push({
        personIds: new Set(c.personIds),
        baseline,
        multiplier,
        roleScope: c.roleScope ?? 'presenter',
        weight: c.weight ?? 1,
      });
    }
  }

  return guidance;
}

function affinityPairFactor(
  presenterId: string,
  questionerId: string,
  guidance: ConstraintGuidance,
): number {
  let factor = 1;
  for (const c of guidance.affinity) {
    if (!c.group.has(presenterId) || !c.group.has(questionerId)) continue;
    const boost = Number.isFinite(c.boost) ? c.boost : 1;
    if (boost > 0) factor = Math.min(factor, 1 / boost);
  }
  return factor;
}

function frequencyRoleFactor(
  personId: string,
  role: 'presenter' | 'questioner',
  guidance: ConstraintGuidance,
): number {
  let factor = 1;
  for (const f of guidance.frequency) {
    if (!f.personIds.has(personId)) continue;
    if (f.roleScope !== 'both' && f.roleScope !== role) continue;
    const m = Number.isFinite(f.multiplier) ? f.multiplier : 1;
    if (m > 0) factor = Math.min(factor, 1 / m);
  }
  return factor;
}

// ---------------------------------------------------------------------------
// Shared helpers (also consumed by optimizer.ts)
// ---------------------------------------------------------------------------

export function incrementCount(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

const MIN_GAP_TARGET_RATIO = 0.7;
const MIN_GAP_PENALTY_WEIGHT = 2;
const MAX_GAP_TARGET_RATIO = 1.3;
const MAX_GAP_PENALTY_WEIGHT = 1.5;

function intervalUniformityPenalty(indicesByPerson: Map<string, number[]>): number {
  let penalty = 0;
  for (const indices of indicesByPerson.values()) {
    if (indices.length < 2) continue;
    const gaps = indices.slice(1).map((v, i) => v - indices[i]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (mean <= 0) continue;
    const variancePenalty = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / (gaps.length * mean * mean);
    const minGap = Math.min(...gaps);
    const targetMinGap = mean * MIN_GAP_TARGET_RATIO;
    const minGapShortfall = Math.max(0, targetMinGap - minGap) / mean;
    const minGapPenalty = MIN_GAP_PENALTY_WEIGHT * (minGapShortfall ** 2);
    const maxGap = Math.max(...gaps);
    const targetMaxGap = mean * MAX_GAP_TARGET_RATIO;
    const maxGapExcess = Math.max(0, maxGap - targetMaxGap) / mean;
    const maxGapPenalty = MAX_GAP_PENALTY_WEIGHT * (maxGapExcess ** 2);
    penalty += variancePenalty + minGapPenalty + maxGapPenalty;
  }
  return penalty;
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
  const guidance = buildConstraintGuidance(ctx);

  const presenterIndices = new Map<string, number[]>();
  const questionerIndices = new Map<string, number[]>();
  const presenterCounts = new Map<string, number>();
  const questionerCounts = new Map<string, number>();
  const totalRoleCounts = new Map<string, number>();

  allSessions.forEach((sess, idx) => {
    for (const p of sess.presentations) {
      const arr = presenterIndices.get(p.presenterId) ?? [];
      arr.push(idx);
      presenterIndices.set(p.presenterId, arr);
      const presenterInc = frequencyRoleFactor(p.presenterId, 'presenter', guidance);
      incrementCount(presenterCounts, p.presenterId, presenterInc);
      incrementCount(totalRoleCounts, p.presenterId, presenterInc);
    }
  });

  // 1. Uniformity – interval penalty for presenter/questioner appearances.
  // Dividing by mean² normalises for frequency-multiplier constraints: a person
  // scheduled twice as often has naturally half the gap, so their absolute
  // variance is inherently ~4× smaller – using CV² makes all persons comparable.
  // Add an extra term for extremely short minimum gaps to avoid schedules that
  // have acceptable variance but still contain a near-back-to-back presentation.
  let uniformityPenalty = intervalUniformityPenalty(presenterIndices);

  // 2. Questioner frequency + hard invalidity
  const questionerFreq = new Map<string, number>();
  let questionerPenalty = 0;
  let invalidAssignmentPenalty = 0;
  allSessions.forEach((sess, idx) => {
    for (const pres of sess.presentations) {
      const seen = new Set<string>();
      for (const q of pres.questionerIds) {
        if (!seen.has(q)) {
          const arr = questionerIndices.get(q) ?? [];
          arr.push(idx);
          questionerIndices.set(q, arr);
        }
        const questionerInc =
          frequencyRoleFactor(q, 'questioner', guidance)
          * affinityPairFactor(pres.presenterId, q, guidance);
        incrementCount(questionerCounts, q, questionerInc);
        incrementCount(totalRoleCounts, q, questionerInc);
        if (q === pres.presenterId) invalidAssignmentPenalty += 1000;
        if (seen.has(q)) invalidAssignmentPenalty += 250;
        seen.add(q);
        const key = `${q}→${pres.presenterId}`;
        const freq = (questionerFreq.get(key) ?? 0) + 1;
        questionerFreq.set(key, freq);
        if (freq > 1) questionerPenalty += Math.exp(freq - 1) - 1;
      }
    }
  });
  uniformityPenalty += intervalUniformityPenalty(questionerIndices);

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
  const constraintPenalty = 0;

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
  const similarities: SimilarityLookup = input.similarities instanceof Map
    ? {
      getPairSimilarity(leftKeywordId: string, rightKeywordId: string): number | undefined {
        const key = leftKeywordId < rightKeywordId
          ? `${leftKeywordId}|${rightKeywordId}`
          : `${rightKeywordId}|${leftKeywordId}`;
        return (input.similarities as Map<string, number>).get(key) || 0;
      },
    }
    : input.similarities;
  return {
    personKeywords: new Map(active.map(p => [p.id, p.keywordIds])),
    similarities,
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