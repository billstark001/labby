/**
 * Cost function and constraint evaluation for the scheduling solver.
 *
 * COST_WEIGHTS defines immutable model defaults; schedules can override individual weights.
 */

import { getPersonSimilarity } from '../nlp.js';
import type {
  ScheduleMetrics,
  ScheduleConfig,
  Session,
  SolverInput,
  ScheduleConstraint,
  NoOverlapConstraint,
  AffinityBoostConstraint,
  ConstraintTargetGroup,
  PairOverlapStrategy,
  Person,
  SimilarityLookup,
  GapBalancePolicy,
  QuestionerOptimizationPolicy,
  ScheduleCostWeights,
} from '../types.js';
import { buildUnavailMap, isWholeGroupClosure } from './utils.js';

// ---------------------------------------------------------------------------
// Configurable cost weights
// ---------------------------------------------------------------------------

const _f = <T>(value: T): Readonly<T> => Object.freeze(value);

/**
 * Weight applied to each term of the objective function.
 * Increase a weight to penalize that term more heavily during optimization.
 */
export const COST_WEIGHTS: Readonly<ScheduleCostWeights> = _f({
  uniformity: 12,
  reciprocal: 1,
  questionerPair: 1,
  /** |sim(questioner, presenter) − r| summed over all pairs. */
  relevance: 0.8,
  /** Uniformity penalty of per-person presenter appearance counts. */
  presenterLoad: 8,
  questionerCount: 8,
  questionerGap: 8,
  /** Uniformity penalty of each person's total role count (presenter + questioner). */
  totalRole: 2,
  /** Hard penalty for self-questioning or duplicate questioners within one presentation. */
  invalidAssignment: 114514,
  constraint: 1,
});

export const DEFAULT_QUESTIONER_OPTIMIZATION: Readonly<QuestionerOptimizationPolicy> = _f({
  assignment: _f({ noveltyChance: 0, balanceChance: 0 }),
  repair: _f({ iterations: 0, pairWeight: 0, countWeight: 0 }),
});

function resolveCostWeights(configured: ScheduleConfig['costWeights']): ScheduleCostWeights {
  return Object.fromEntries((Object.keys(COST_WEIGHTS) as (keyof ScheduleCostWeights)[]).map(key => {
    const value = configured?.[key];
    const maximum = key === 'invalidAssignment' ? 1_000_000 : 100;
    return [key, value !== undefined && Number.isFinite(value)
      ? Math.min(maximum, Math.max(0, value)) : COST_WEIGHTS[key]];
  })) as unknown as ScheduleCostWeights;
}

function resolveQuestionerOptimization(
  value: ScheduleConfig['questionerOptimization'],
): QuestionerOptimizationPolicy {
  const bounded = (candidate: number | undefined, fallback: number, maximum: number) =>
    candidate !== undefined && Number.isFinite(candidate)
      ? Math.min(maximum, Math.max(0, candidate)) : fallback;
  const defaults = DEFAULT_QUESTIONER_OPTIMIZATION;
  return {
    assignment: {
      noveltyChance: bounded(value?.assignment?.noveltyChance, defaults.assignment.noveltyChance, 1),
      balanceChance: bounded(value?.assignment?.balanceChance, defaults.assignment.balanceChance, 1),
    },
    repair: {
      iterations: Math.floor(bounded(value?.repair?.iterations, defaults.repair.iterations, 500)),
      pairWeight: bounded(value?.repair?.pairWeight, defaults.repair.pairWeight, 50),
      countWeight: bounded(value?.repair?.countWeight, defaults.repair.countWeight, 50),
    },
  };
}

export const DEFAULT_GAP_BALANCE = {
  presenter: { shortGapRatio: 0.8, shortGapWeight: 20, spreadWeight: 4 },
  questioner: { shortGapRatio: 0.75, shortGapWeight: 16, spreadWeight: 2 },
} satisfies Record<'presenter' | 'questioner', GapBalancePolicy>;

function resolveGapBalance(configured: Partial<GapBalancePolicy> | undefined, defaults: GapBalancePolicy): GapBalancePolicy {
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
    value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    shortGapRatio: bounded(configured?.shortGapRatio, defaults.shortGapRatio, 0, 1),
    shortGapWeight: bounded(configured?.shortGapWeight, defaults.shortGapWeight, 0, 100),
    spreadWeight: bounded(configured?.spreadWeight, defaults.spreadWeight, 0, 50),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostContext {
  personKeywords: Map<string, string[]>;
  personTags: Map<string, string[]>;
  similarities: SimilarityLookup;
  /** Target similarity radius r. */
  r: number;
  reciprocalPreference: 'forbid' | 'discourage' | 'neutral' | 'encourage';
  constraints?: ScheduleConstraint[];
  gapBalance: Record<'presenter' | 'questioner', GapBalancePolicy>;
  questionerOptimization: QuestionerOptimizationPolicy;
  costWeights: ScheduleCostWeights;
}

export interface CostBreakdown {
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
}


// #region Constraint guidance and evaluation


export interface NoOverlapGuide {
  memberships: Map<string, { group: number; multiple: boolean }>;
  groupCount: number;
  overlapStrategy: PairOverlapStrategy;
}

export interface AffinityGuide extends NoOverlapGuide {
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

type PairConstraint = NoOverlapConstraint | AffinityBoostConstraint;

function pairTargetGroups(c: PairConstraint): ConstraintTargetGroup[] {
  return c.groups.filter(group => group.personIds.length || group.tagIds.length);
}

export function resolvePairConstraint(c: PairConstraint, personTags: Map<string, string[]>): NoOverlapGuide {
  const groups = pairTargetGroups(c).map(group => ({
    personIds: new Set(group.personIds), tagIds: new Set(group.tagIds),
  }));
  const memberships = new Map<string, { group: number; multiple: boolean }>();
  for (const [id, tags] of personTags) {
    let firstGroup = -1;
    let multiple = false;
    for (const [index, group] of groups.entries()) {
      if (!group.personIds.has(id) && !tags.some(tag => group.tagIds.has(tag))) continue;
      if (firstGroup < 0) firstGroup = index;
      else multiple = true;
    }
    if (firstGroup >= 0) memberships.set(id, { group: firstGroup, multiple });
  }
  return { memberships, groupCount: groups.length, overlapStrategy: c.overlapStrategy ?? 'include-multi-group' };
}

export function pairConstraintMatches(group: NoOverlapGuide, a: string, b: string): boolean {
  if (a === b) return false;
  const left = group.memberships.get(a);
  const right = group.memberships.get(b);
  if (!left || !right) return false;
  if (group.groupCount === 1) return true;
  if (group.overlapStrategy === 'exclusive-only') {
    return !left.multiple && !right.multiple && left.group !== right.group;
  }
  return left.multiple || right.multiple || left.group !== right.group;
}

/** Uses the same matching rule as the solver, with disabled people excluded. */
export function previewConstraintPairs(c: PairConstraint, persons: Person[]): Array<[string, string]> {
  const active = persons.filter(person => !person.disabled);
  const guide = resolvePairConstraint(c, new Map(active.map(person => [person.id, person.tagIds ?? []])));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (pairConstraintMatches(guide, active[i].id, active[j].id)) pairs.push([active[i].id, active[j].id]);
    }
  }
  return pairs;
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
  const resolve = (personIds: string[], tagIds: string[]): Set<string> => new Set(
    [...ctx.personTags].filter(([id, tags]) => personIds.includes(id) || tags.some(tag => tagIds.includes(tag))).map(([id]) => id),
  );

  for (const c of ctx.constraints ?? []) {
    if (c.disabled) continue;
    if (c.type === 'no-overlap') {
      guidance.noOverlap.push(resolvePairConstraint(c, ctx.personTags));
      continue;
    }

    if (c.type === 'affinity-boost') {
      guidance.affinity.push({
        ...resolvePairConstraint(c, ctx.personTags),
        boost: c.boost ?? 2,
      });
      continue;
    }

    if (c.type === 'frequency-multiplier') {
      const baseline = Number.isFinite(c.baseline) ? Math.max(0, c.baseline) : 0;
      const multiplier = Number.isFinite(c.multiplier) ? c.multiplier : 1;
      const members = resolve(c.personIds, c.tagIds);
      for (const id of members) {
        allPersonIds.add(id);
      }
      guidance.frequency.push({
        personIds: members,
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
    if (pairConstraintMatches(c, presenterId, questionerId)) return true;
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
    if (!pairConstraintMatches(c, presenterId, questionerId)) continue;
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
    const m = Number.isFinite(f.multiplier) ? Math.max(0, f.multiplier) : 1;
    factor *= Math.max(0.01, f.baseline * m);
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

function buildAllCounts(indicesByPerson: Map<string, number[]>, weights: Map<string, number>, personIds: string[]): number[] {
  const allCounts: number[] = [];

  for (const personId of personIds) {
    const indices = indicesByPerson.get(personId) ?? [];
    const factor = weights.get(personId) ?? 1;
    allCounts.push(indices.length / factor);
  }
  return allCounts;
}

/** Score one person's gaps; boundary waits guide placement while consecutive gaps determine spread. */
export function personGapCost(occurrences: number[], first: number, last: number, policy: GapBalancePolicy): number {
  if (!occurrences.length) return 0;
  const ordered = [...occurrences].sort((a, b) => a - b);
  const target = (last - first) / (ordered.length + 1);
  if (target <= 0) return 0;
  const internalGaps = ordered.slice(1).map((date, i) => date - ordered[i]!);
  const gaps = [ordered[0]! - first, ...internalGaps, last - ordered[ordered.length - 1]!];
  let penalty = 0;
  for (const gap of gaps) {
    const deviation = (gap - target) / target;
    penalty += deviation * deviation;
  }
  for (const gap of internalGaps) penalty += policy.shortGapWeight * Math.max(0, policy.shortGapRatio - gap / target) ** 2;
  if (internalGaps.length > 1) {
    const mean = internalGaps.reduce((sum, gap) => sum + gap, 0) / internalGaps.length;
    penalty += policy.spreadWeight * internalGaps.reduce((sum, gap) => sum + ((gap - mean) / target) ** 2, 0) / internalGaps.length;
  }
  return penalty;
}

/** Each person's own calendar gaps, including half-session padding at both ends. */
function perPersonGapPenalty(indicesByPerson: Map<string, number[]>, dates: number[], personIds: string[], policy: GapBalancePolicy): number {
  if (dates.length < 2) return 0;
  const ordered = [...dates].sort((a, b) => a - b);
  const spacings = ordered.slice(1).map((date, i) => date - ordered[i]!);
  spacings.sort((a, b) => a - b);
  const nominal = spacings[Math.floor(spacings.length / 2)] ?? 7;
  const first = ordered[0]! - nominal / 2;
  const last = ordered[ordered.length - 1]! + nominal / 2;
  let penalty = 0;
  for (const id of personIds) {
    penalty += personGapCost((indicesByPerson.get(id) ?? []).map(index => dates[index]!), first, last, policy);
  }
  return penalty;
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
  let reciprocalPenalty = 0;
  let constraintPenalty = 0;
  const questionerFreq = new Map<string, number>();
  const dateDays = allSessions.map(session => Date.parse(`${session.date}T00:00:00Z`) / 86400000);

  allSessions.forEach((sess, idx) => {
    const directedPairs = new Set<string>();
    const presentersThisSession = new Set<string>();
    for (const pres of sess.presentations) {
      if (presentersThisSession.has(pres.presenterId)) invalidAssignmentPenalty += 1;
      presentersThisSession.add(pres.presenterId);
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
        if (noOverlapForbidden(pres.presenterId, q, guidance)) constraintPenalty += ctx.costWeights.invalidAssignment;
        for (const c of guidance.affinity) {
          if (pairConstraintMatches(c, pres.presenterId, q)) constraintPenalty -= Math.log(Math.max(0.01, c.boost)) * 4;
        }
        seen.add(q);
        directedPairs.add(`${pres.presenterId}|${q}`);
        const key = `${q}→${pres.presenterId}`;
        const freq = (questionerFreq.get(key) ?? 0) + 1;
        questionerFreq.set(key, freq);
        if (freq > 1) questionerPenalty += Math.exp(freq - 1) - 1;
      }
    }
    if (ctx.reciprocalPreference !== 'neutral') {
      for (const pair of directedPairs) {
        const [a, b] = pair.split('|');
        if (a! < b! && directedPairs.has(`${b}|${a}`)) {
          reciprocalPenalty += ctx.reciprocalPreference === 'forbid'
            ? ctx.costWeights.invalidAssignment
            : ctx.reciprocalPreference === 'discourage' ? 10 : -10;
        }
      }
    }
  });

  const presenterAllCounts = buildAllCounts(presenterIndices, guidance.presenterWeights, personIds);
  const questionerAllCounts = buildAllCounts(questionerIndices, guidance.questionerWeights, personIds);

  // 3. Uniformity penalty
  const uniformityPenaltyValue = perPersonGapPenalty(presenterIndices, dateDays, personIds, ctx.gapBalance.presenter);
  const presenterLoadPenalty = uniformityPenalty(presenterAllCounts);
  const questionerCountPenalty = uniformityPenalty(questionerAllCounts);
  const questionerGapPenalty = perPersonGapPenalty(questionerIndices, dateDays, personIds, ctx.gapBalance.questioner);

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

  for (const rule of guidance.frequency) {
    const roles = rule.roleScope;
    const allCount = (roles === 'presenter' ? [...presenterIndices.values()].flat().length
      : roles === 'questioner' ? [...questionerIndices.values()].flat().length
        : [...presenterIndices.values(), ...questionerIndices.values()].flat().length);
    const target = personIds.length ? allCount / personIds.length * rule.baseline * rule.multiplier : 0;
    for (const id of rule.personIds) {
      const actual = (roles === 'questioner' ? 0 : (presenterIndices.get(id)?.length ?? 0))
        + (roles === 'presenter' ? 0 : (questionerIndices.get(id)?.length ?? 0));
      constraintPenalty += rule.weight * (actual - target) ** 2 / Math.max(1, target);
    }
  }

  return {
    uniformityPenalty: uniformityPenaltyValue,
    reciprocalPenalty,
    questionerPenalty,
    relevancePenalty,
    presenterLoadPenalty,
    questionerCountPenalty,
    questionerGapPenalty,
    totalRolePenalty,
    invalidAssignmentPenalty,
    constraintPenalty,
  };
}

export function weightedTotalCost(
  breakdown: CostBreakdown,
  weights: ScheduleCostWeights = COST_WEIGHTS,
): number {
  return (
    breakdown.uniformityPenalty * weights.uniformity
    + breakdown.reciprocalPenalty * weights.reciprocal
    + breakdown.questionerPenalty * weights.questionerPair
    + breakdown.relevancePenalty * weights.relevance
    + breakdown.presenterLoadPenalty * weights.presenterLoad
    + breakdown.questionerCountPenalty * weights.questionerCount
    + breakdown.questionerGapPenalty * weights.questionerGap
    + breakdown.totalRolePenalty * weights.totalRole
    + breakdown.invalidAssignmentPenalty * weights.invalidAssignment
    + breakdown.constraintPenalty * weights.constraint
  );
}

export function toScheduleMetrics(breakdown: CostBreakdown, ctx: CostContext): ScheduleMetrics {
  return { ...breakdown, totalCost: weightedTotalCost(breakdown, ctx.costWeights) };
}

export function buildCostContext(input: SolverInput): CostContext {
  const active = input.persons.filter(p => !p.disabled);
  return {
    personKeywords: new Map(active.map(p => [p.id, p.keywordIds])),
    personTags: new Map(active.map(p => [p.id, p.tagIds ?? []])),
    similarities: input.similarities,
    r: input.config.targetSimilarityRadius,
    reciprocalPreference: input.config.reciprocalPairPreference ?? 'neutral',
    constraints: input.constraints ?? [],
    gapBalance: {
      presenter: resolveGapBalance(input.config.gapBalance?.presenter, DEFAULT_GAP_BALANCE.presenter),
      questioner: resolveGapBalance(input.config.gapBalance?.questioner, DEFAULT_GAP_BALANCE.questioner),
    },
    questionerOptimization: resolveQuestionerOptimization(input.config.questionerOptimization),
    costWeights: resolveCostWeights(input.config.costWeights),
  };
}

export function computeCost(
  sessions: Session[],
  ctx: CostContext,
  guidance: ConstraintGuidance,
  historicalSessions: Session[] = [],
): number {
  return weightedTotalCost(
    computeCostBreakdown(sessions, ctx, guidance, historicalSessions),
    ctx.costWeights,
  );
}

/** Validate the hard assignment rules against the people and constraints in a solve. */
export function validateScheduleAssignments(sessions: Session[], input: SolverInput): string[] {
  const ctx = buildCostContext(input);
  const guidance = buildConstraintGuidance(ctx);
  const unavailable = buildUnavailMap(input.unavailabilities ?? [], input.config.id, input.persons, sessions.map(session => session.date));
  const closed = sessions.filter(session => isWholeGroupClosure(session.date, input.unavailabilities ?? [], input.config.id))
    .map(session => `Session falls on a whole-group closure: ${session.date}`);
  return [...closed, ...validateAssignmentsWithContext(sessions, ctx, guidance, unavailable)];
}

export function validateAssignmentsWithContext(
  sessions: Session[], ctx: CostContext, guidance: ConstraintGuidance,
  unavailable: Map<string, Set<string>>,
): string[] {
  const errors: string[] = [];
  for (const session of sessions) {
    const seenPresenters = new Set<string>();
    const pairs = new Set<string>();
    for (const presentation of session.presentations) {
      const presenter = presentation.presenterId;
      if (!ctx.personKeywords.has(presenter) || unavailable.get(session.date)?.has(presenter))
        errors.push(`Invalid presenter on ${session.date}`);
      if (seenPresenters.has(presenter)) errors.push(`Duplicate presenter on ${session.date}`);
      seenPresenters.add(presenter);
      const seenQuestioners = new Set<string>();
      for (const questioner of presentation.questionerIds) {
        if (!ctx.personKeywords.has(questioner) || unavailable.get(session.date)?.has(questioner))
          errors.push(`Invalid questioner on ${session.date}`);
        if (questioner === presenter || seenQuestioners.has(questioner))
          errors.push(`Duplicate or self-questioning assignment on ${session.date}`);
        if (noOverlapForbidden(presenter, questioner, guidance))
          errors.push(`No-overlap constraint violated on ${session.date}`);
        seenQuestioners.add(questioner);
        pairs.add(`${presenter}|${questioner}`);
      }
    }
    if (ctx.reciprocalPreference === 'forbid') {
      for (const pair of pairs) {
        const [a, b] = pair.split('|');
        if (a! < b! && pairs.has(`${b}|${a}`))
          errors.push(`Reciprocal questioning is forbidden on ${session.date}`);
      }
    }
  }
  return errors;
}
