/**
 * Cost function and constraint evaluation for the scheduling solver.
 *
 * All penalty weights are configurable by editing COST_WEIGHTS.
 */

import { getPersonSimilarity } from '../nlp.js';
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
  /** Unused */
  uniformity: 1,
  /** Exponential penalty for repeated (questioner → presenter) pairs. */
  questioner: 1,
  /** |sim(questioner, presenter) − r| summed over all pairs. */
  relevance: 0.8,
  /** Uniformity penalty of per-person presenter appearance counts & gaps. */
  presenterLoad: 8,
  /** Uniformity penalty of per-person questioner appearance counts & gaps. */
  questionerLoad: 8,
  /** Uniformity penalty of each person's total role count (presenter + questioner). */
  totalRole: 2,
  /** Hard penalty for self-questioning or duplicate questioners within one presentation. */
  invalidAssignment: 114514,
  /** Unused */
  constraint: 1,
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


// #region Constraint guidance and evaluation


export interface NoOverlapGuide {
  group: Set<string>;
}

export interface AffinityGuide {
  group: Set<string>;
  boost: number;
}

export interface FrequencyGuide {
  personIds: Set<string>;
  baseline: number;
  multiplier: number;
  roleScope: 'presenter' | 'questioner' | 'both';
  weight: number;
}

export interface ConstraintGuidance {
  noOverlap: NoOverlapGuide[];
  affinity: AffinityGuide[];
  frequency: FrequencyGuide[];
  presenterWeights: Map<string, number>;
  questionerWeights: Map<string, number>;
}

// #region Constraint guidance and evaluation

export function buildConstraintGuidance(ctx: CostContext): ConstraintGuidance {
  const guidance: ConstraintGuidance = {
    noOverlap: [],
    affinity: [],
    frequency: [],
    presenterWeights: new Map(),
    questionerWeights: new Map(),
  };

  const allPersonIds = new Set<string>();

  for (const c of ctx.constraints ?? []) {
    if (c.type === 'no-overlap') {
      guidance.noOverlap.push({
        group: new Set(c.personIds),
      });
      continue;
    }

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
      for (const id of c.personIds) {
        allPersonIds.add(id);
      }
      guidance.frequency.push({
        personIds: new Set(c.personIds),
        baseline,
        multiplier,
        roleScope: c.roleScope ?? 'presenter',
        weight: c.weight ?? 1,
      });
    }
  }

  for (const id of allPersonIds) {
    guidance.presenterWeights?.set(id, frequencyRoleWeight(id, 'presenter', guidance));
    guidance.questionerWeights?.set(id, frequencyRoleWeight(id, 'questioner', guidance));
  }

  return guidance;
}


export function noOverlapForbidden(
  presenterId: string,
  questionerId: string,
  guidance: ConstraintGuidance,
): boolean {
  for (const c of guidance.noOverlap) {
    if (c.group.has(presenterId) && c.group.has(questionerId)) return true;
  }
  return false;
}


export function affinityPairWeight(
  presenterId: string,
  questionerId: string,
  guidance: ConstraintGuidance,
): number {
  let factor = 1;
  for (const c of guidance.affinity) {
    if (!c.group.has(presenterId) || !c.group.has(questionerId)) continue;
    const boost = Number.isFinite(c.boost) ? c.boost : 1;
    if (boost > 0) factor *= boost;
  }
  return factor;
}

export function frequencyRoleWeight(
  personId: string,
  role: 'presenter' | 'questioner',
  guidance: ConstraintGuidance,
): number {
  let factor = 1;
  for (const f of guidance.frequency) {
    if (!f.personIds.has(personId)) continue;
    if (f.roleScope !== 'both' && f.roleScope !== role) continue;
    const m = Number.isFinite(f.multiplier) ? f.multiplier : 1;
    if (m > 0) factor *= m;
  }
  return factor;
}

// #endregion

// #region Metrics explanation


const MIN_GAP_TARGET_RATIO = 0.9;
const MIN_GAP_PENALTY_WEIGHT = 2;
const MAX_GAP_TARGET_RATIO = 1;
const MAX_GAP_PENALTY_WEIGHT = 1.5;
const VARIANCE_PENALTY_WEIGHT = 2;

interface UniformityPenaltyOptions {
  minGapTargetRatio?: number;
  maxGapTargetRatio?: number;

  variancePenaltyWeight?: number;
  minGapPenaltyWeight?: number;
  maxGapPenaltyWeight?: number;

  meanOverride?: number;
}

function uniformityPenalty(
  numbers: number[],
  options: UniformityPenaltyOptions = {},
): number {
  if (numbers.length === 0) return 0;

  const {
    minGapTargetRatio = MIN_GAP_TARGET_RATIO,
    maxGapTargetRatio = MAX_GAP_TARGET_RATIO,
    variancePenaltyWeight = VARIANCE_PENALTY_WEIGHT,
    minGapPenaltyWeight = MIN_GAP_PENALTY_WEIGHT,
    maxGapPenaltyWeight = MAX_GAP_PENALTY_WEIGHT,
    meanOverride,
  } = options;

  const mean = meanOverride ?? numbers.reduce((s, v) => s + v, 0) / numbers.length;
  if (mean <= 0) return 0;

  const variance = numbers.reduce((s, v) => s + (v - mean) ** 2, 0) / numbers.length;

  const minGap = Math.min(...numbers);
  const targetMinGap = mean * minGapTargetRatio;
  const minGapShortfall = Math.max(0, targetMinGap - minGap) / mean;
  const minGapPenalty = minGapShortfall ** 2;

  const maxGap = Math.max(...numbers);
  const targetMaxGap = mean * maxGapTargetRatio;
  const maxGapExcess = Math.max(0, maxGap - targetMaxGap) / mean;
  const maxGapPenalty = maxGapExcess ** 2;

  return (
    variancePenaltyWeight * variance +
    minGapPenaltyWeight * minGapPenalty +
    maxGapPenaltyWeight * maxGapPenalty
  );
}

function buildAllCountsAndAllGaps(indicesByPerson: Map<string, number[]>, weights: Map<string, number>, personIds?: string[]): { allCounts: number[]; allGaps: number[] } {
  const allCounts: number[] = [];
  const allGaps: number[] = [];

  for (const personId of personIds ?? indicesByPerson.keys()) {
    const indices = indicesByPerson.get(personId) ?? [];
    const factor = weights.get(personId) || 1;
    allCounts.push(indices.length / factor);
    if (indices.length < 2) continue;
    const gaps = indices.slice(1).map((v, i) => v - indices[i]);
    allGaps.push(...gaps);
  }
  return {
    allCounts,
    allGaps,
  }
}


// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

export function computeCostBreakdown(
  sessions: Session[],
  ctx: CostContext,
  guidance: ConstraintGuidance,
  historicalSessions: Session[] = [],
): CostBreakdown {
  const allSessions = [...historicalSessions, ...sessions];
  const personIds = [...ctx.personKeywords.keys()];

  const presenterIndices = new Map<string, number[]>();
  const questionerIndices = new Map<string, number[]>();

  // 1. Invalid assignments
  let invalidAssignmentPenalty = 0;

  // 2. Questioner frequency
  let questionerPenalty = 0;
  const questionerFreq = new Map<string, number>();

  allSessions.forEach((sess, idx) => {
    for (const pres of sess.presentations) {
      // Record presenter indices for uniformity penalty calculation.
      const arr = presenterIndices.get(pres.presenterId) ?? [];
      arr.push(idx);
      presenterIndices.set(pres.presenterId, arr);

      // Record questioner indices and frequencies for uniformity and questioner
      const seen = new Set<string>();
      for (const q of pres.questionerIds) {
        if (!seen.has(q)) {
          const arr = questionerIndices.get(q) ?? [];
          arr.push(idx);
          questionerIndices.set(q, arr);
        }

        if (q === pres.presenterId) invalidAssignmentPenalty += 1;
        if (seen.has(q)) invalidAssignmentPenalty += 0.5;
        seen.add(q);
        const key = `${q}→${pres.presenterId}`;
        const freq = (questionerFreq.get(key) ?? 0) + 1;
        questionerFreq.set(key, freq);
        if (freq > 1) questionerPenalty += Math.exp(freq - 1) - 1;
      }
    }
  });

  const {
    allCounts: presenterAllCounts,
    allGaps: presenterAllGaps,
  } = buildAllCountsAndAllGaps(presenterIndices, guidance.presenterWeights, personIds);

  const {
    allCounts: questionerAllCounts,
    allGaps: questionerAllGaps,
  } = buildAllCountsAndAllGaps(questionerIndices, guidance.questionerWeights, personIds);

  const gapOptions: UniformityPenaltyOptions = {
    minGapTargetRatio: 0.9,
    maxGapTargetRatio: 1.1,
    variancePenaltyWeight: 5,
  };

  // 3. Uniformity penalty
  const presenterLoadPenalty = uniformityPenalty(presenterAllCounts) + uniformityPenalty(presenterAllGaps, gapOptions);
  const questionerLoadPenalty = uniformityPenalty(questionerAllCounts) + uniformityPenalty(questionerAllGaps, gapOptions);

  // 4. Domain relevance – |sim(q, presenter) − r|
  let relevancePenalty = 0;
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      const pk = ctx.personKeywords.get(pres.presenterId) ?? [];
      for (const q of pres.questionerIds) {
        relevancePenalty += Math.abs(
          getPersonSimilarity(pk, ctx.personKeywords.get(q) ?? [], ctx.similarities) - ctx.r,
        );
      }
    }
  }

  // 5. Total role
  const totalRoleAllCounts = presenterAllCounts.map((c, i) => c + questionerAllCounts[i]);
  const totalRolePenalty = uniformityPenalty(totalRoleAllCounts);

  return {
    uniformityPenalty: 0,
    questionerPenalty,
    relevancePenalty,
    presenterLoadPenalty,
    questionerLoadPenalty,
    totalRolePenalty,
    invalidAssignmentPenalty,
    constraintPenalty: 0,
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
  guidance: ConstraintGuidance,
  historicalSessions: Session[] = [],
): number {
  return weightedTotalCost(computeCostBreakdown(sessions, ctx, guidance, historicalSessions));
}