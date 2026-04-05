/**
 * Schedule builder and simulated annealing optimizer.
 *
 * Mutation strategies and annealing hyperparameters are tunable via
 * MUTATION_WEIGHTS and ANNEALING_CONFIG.
 */

import type { Session, Presentation, ScheduleConfig, ScheduleSolver, IncrementalSolverInput, SchedulePlan, SolverInput, SimilarityLookup } from '../types.js';
import {
  type CostContext,
  incrementCount,
  personSimilarity,
  computeCost,
  buildCostContext,
} from './constraints.js';
import { generateSessionDates, generateId, buildUnavailMap, replaySessionMutationDates } from './utils.js';
import { drrInit, drrNext, drrRecover, DRRState, vftNext, vftRecover, VFTState } from './wps.js';

// ---------------------------------------------------------------------------
// Configurable hyperparameters
// ---------------------------------------------------------------------------

/**
 * Relative probability weight for each mutation strategy.
 * Values need not sum to 1 – they are normalized at runtime.
 *
 * Raise `frequencyTargeted` to fix frequency-multiplier constraint violations
 * more aggressively; raise `sessionRebuild` to escape deep local minima.
 */
export const MUTATION_WEIGHTS = {
  /** Swap presenter slots between two random sessions. */
  swapPresenters: 0.20,
  /** Reassign questioners for a random presentation. */
  reassignQuestioners: 0.20,
  /**
   * Replace a random presenter with the most under-represented eligible person
   * not currently scheduled in that session.
   */
  replacePresenter: 0.20,
  /**
   * Directly fix the person with the largest frequency-multiplier deviation by
   * inserting or removing them from a presentation slot.
   */
  frequencyTargeted: 0.25,
  /** Fully rebuild all presenter and questioner assignments for one session. */
  sessionRebuild: 0.15,
};

/** Simulated annealing hyperparameters. */
export const ANNEALING_CONFIG = {
  maxIter: 5000,
  initialTemp: 1.0,
  coolingRate: 0.995,
  /** Hamming penalty weight applied during incremental solves. */
  hammingWeight: 10,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NoOverlapGuide {
  group: Set<string>;
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
  noOverlap: NoOverlapGuide[];
  affinity: AffinityGuide[];
  frequency: FrequencyGuide[];
}

// #region Constraint guidance and evaluation

function buildConstraintGuidance(ctx: CostContext): ConstraintGuidance {
  const guidance: ConstraintGuidance = {
    noOverlap: [],
    affinity: [],
    frequency: [],
  };

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

function noOverlapForbidden(
  presenterId: string,
  questionerId: string,
  guidance: ConstraintGuidance,
): boolean {
  for (const c of guidance.noOverlap) {
    if (c.group.has(presenterId) && c.group.has(questionerId)) return true;
  }
  return false;
}


function affinityPairWeight(
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

function frequencyRoleWeight(
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

// #region Assignment state

function buildNumberedPersonIds(
  sessions: Session[],
  personIds: string[],
) {

  const personReverseMap = new Map<string, number>(personIds.map((id, i) => [id, i]));

  const presenterNumbers =  sessions.flatMap(s => s.presentations.map(p => personReverseMap.get(p.presenterId)!));
  const presenterIndices = sessions.map(s => s.presentations.length).reduce((acc, len) => [...acc, acc[acc.length - 1] + len], [0]).slice(0, -1);

  const questionerNumbers = sessions.flatMap(s => s.presentations.flatMap(p => p.questionerIds.map(q => personReverseMap.get(q)!)));
  const questionerIndices = sessions.map(s => s.presentations.reduce((acc, p) => [...acc, acc[acc.length - 1] + p.questionerIds.length], [0])).slice(0, -1);

  return {
    personReverseMap,
    presenterNumbers,
    presenterIndices,
    questionerNumbers,
    questionerIndices,
  }
}

function choosePresenters(
  personIds: string[],
  count: number,
  drrState: DRRState,
  isUnavailable?: (id: string) => boolean,
) {
  const presenters: string[] = [];
  for (let j = 0; j < count; j++) {
    const idx = drrNext(drrState, i => {
      const id = personIds[i];
      return isUnavailable?.(id) || presenters.includes(id);
    });
    if (idx === null) break; // All candidates vetoed
    presenters.push(personIds[idx]);
  }
  return presenters;
}

function chooseQuestioners(
  presenterId: string,
  personIds: string[],
  count: number,
  similarityFactor: (presenterId: string, questionerId: string) => number,
  vftState: VFTState,
  guidance: ConstraintGuidance,
  isUnavailable?: (id: string) => boolean,
) {
  const isVetoed = (i: number) => {
      const id = personIds[i];
      return (
        id === presenterId
        || noOverlapForbidden(presenterId, id, guidance)
        || isUnavailable?.(id)
        || questionerIds.includes(id)
      );
    };
    const weightAdjust = (i: number) => {
      const id = personIds[i];
      return vftState.weights[i]
        * affinityPairWeight(presenterId, id, guidance)
        * similarityFactor(presenterId, id);
    };

  const questionerIds: string[] = [];
  for (let j = 0; j < count; j++) {
    const idx = vftNext(vftState, isVetoed, weightAdjust);
    if (idx === null) break; // All candidates vetoed
    questionerIds.push(personIds[idx]);
  }
  return questionerIds;
}

// #endregion

// #region Utilities

export function deepCloneSessions(sessions: Session[]): Session[] {
  return sessions.map(s => ({
    date: s.date,
    presentations: s.presentations.map(p => ({
      presenterId: p.presenterId,
      questionerIds: [...p.questionerIds],
    })),
  }));
}

export function hammingDistance(a: Session[], b: Session[]): number {
  const mapB = new Map(b.map(s => [s.date, new Set(s.presentations.map(p => p.presenterId))]));
  let diff = 0;
  for (const s of a) {
    const bp = mapB.get(s.date);
    if (!bp) { diff += s.presentations.length; continue; }
    for (const p of s.presentations) { if (!bp.has(p.presenterId)) diff++; }
  }
  return diff;
}
  
// #endregion

// #region Schedule builder

export function buildRandomSchedule(
  personIds: string[],
  dates: string[],
  config: ScheduleConfig,
  ctx: CostContext,
  historicalSessions: Session[] = [],
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  if (personIds.length === 0) return dates.map(date => ({ date, presentations: [] }));

  const maxPresenters = Math.min(config.presentersPerSession, personIds.length);
  const sessions: Session[] = [];
  const guidance = buildConstraintGuidance(ctx);

  const { presenterNumbers, questionerNumbers } = buildNumberedPersonIds(historicalSessions, personIds);

  const weights = personIds.map(id => frequencyRoleWeight(id, 'presenter', guidance));
  const drrState = drrRecover(
    presenterNumbers,
    weights,
    undefined,
    0.04,
  );

  const weightsQuestioner = personIds.map(id => frequencyRoleWeight(id, 'questioner', guidance));
  const vftStateQuestioner = vftRecover(
    questionerNumbers,
    weightsQuestioner,
    undefined,
    0.1,
  );
  
  const similarityFactorScaleBottom = 0.2;
  const similarityFactorScaleTop = 0.6;
  const similarityFactor = (presenterId: string, questionerId: string) => {
    const rawSimilarity = personSimilarity(
      ctx.personKeywords.get(presenterId) ?? [],
      ctx.personKeywords.get(questionerId) ?? [],
      ctx.similarities,
    );
    const diff = Math.abs(rawSimilarity - ctx.r);
    const scaledDiff = (diff - similarityFactorScaleBottom) / (similarityFactorScaleTop - similarityFactorScaleBottom);
    console.log(diff, scaledDiff);
    return Math.min(Math.max(0, 1 - scaledDiff), 1);
  };

  for (let si = 0; si < dates.length; si++) {
    const date = dates[si];
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const n = Math.min(maxPresenters, personIds.length - unavail.size);
    if (n === 0) { sessions.push({ date, presentations: [] }); continue; }

    // choose presenters
    const presenters = choosePresenters(personIds, n, drrState, id => unavail.has(id));

    const presentations: Presentation[] = [];

    for (const presenterId of presenters) {

      const questionerIds = chooseQuestioners(
        presenterId,
        personIds,
        config.questionersPerPresenter,
        similarityFactor,
        vftStateQuestioner,
        guidance,
        id => unavail.has(id),
      );

      presentations.push({ presenterId, questionerIds });
    }
    sessions.push({ date, presentations });
  }
  return sessions;
}

// #endregion

// #region Annealing

export function mutate(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  if (!sessions.length) return sessions;
  const clone = deepCloneSessions(sessions);

  // TODO

  return clone;
}

export function simulatedAnnealing(
  initial: Session[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  hammingRef: Session[] | null,
  hammingWeight: number,
  unavailMap: Map<string, Set<string>> = new Map(),
  maxIter = ANNEALING_CONFIG.maxIter,
): Session[] {
  const personIds = [...ctx.personKeywords.keys()];
  const totalCost = (s: Session[]) =>
    computeCost(s, ctx, historicalSessions) +
    (hammingRef ? hammingWeight * hammingDistance(s, hammingRef) : 0);

  let current = deepCloneSessions(initial);
  let currentCost = totalCost(current);
  let best = deepCloneSessions(current);
  let bestCost = currentCost;

  for (let iter = 0; iter < maxIter; iter++) {
    const temp = ANNEALING_CONFIG.initialTemp * ANNEALING_CONFIG.coolingRate ** iter;
    const neighbor = mutate(current, personIds, ctx, historicalSessions, config, unavailMap);
    const neighborCost = totalCost(neighbor);
    const delta = neighborCost - currentCost;

    if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
      current = neighbor;
      currentCost = neighborCost;
      if (currentCost < bestCost) {
        best = deepCloneSessions(current);
        bestCost = currentCost;
      }
    }
  }
  return best;
}

export const annealingSolver: ScheduleSolver = {
  solveFull(input: SolverInput): SchedulePlan {
    const { config, unavailabilities = [] } = input;
    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const dates = generateSessionDates(config);
    const unavailMap = buildUnavailMap(unavailabilities, config.id);
  
    const initial = buildRandomSchedule(personIds, dates, config, ctx, [], unavailMap);
    const optimized = initial; // simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap);
  
    return {
      id: generateId(),
      createdAt: Date.now(),
      configId: config.id,
      sessions: optimized,
    };
  },
  
  /**
   * Re-schedule sessions from changeDate onward, minimizing divergence from the
   * previous plan via a Hamming penalty.
   */
  solveIncremental(input: IncrementalSolverInput): SchedulePlan {
    const { config, previousPlan, changeDate, unavailabilities = [] } = input;
  
    const frozenSessions = previousPlan.sessions.filter(s => s.date < changeDate);
    const replayedDates = replaySessionMutationDates(generateSessionDates(config), previousPlan);
    const mutableDates = replayedDates.filter(d => d >= changeDate);
  
    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const unavailMap = buildUnavailMap(unavailabilities, config.id);
    const hammingRef = previousPlan.sessions.filter(s => s.date >= changeDate);
  
    const initial = buildRandomSchedule(personIds, mutableDates, config, ctx, frozenSessions, unavailMap);
    const optimized = initial;
    // const optimized = simulatedAnnealing(
    //   initial, ctx, frozenSessions, config,
    //   hammingRef, ANNEALING_CONFIG.hammingWeight, unavailMap,
    // );
  
    return {
      id: generateId(),
      createdAt: Date.now(),
      configId: config.id,
      sessions: [...frozenSessions, ...optimized],
    };
  },
}

// #endregion