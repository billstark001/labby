/**
 * Schedule construction and orchestration. Search moves live in strategy modules.
 */

import { getPersonSimilarity } from '../nlp.js';
import type { Session, Presentation, ScheduleConfig, ScheduleSolver, IncrementalSolverInput, SolverInput, SolverDiagnostics, QuestionerAssignmentPolicy } from '../types.js';
import {
  type CostContext,
  computeCost,
  buildCostContext,
  affinityPairWeight,
  buildConstraintGuidance,
  ConstraintGuidance,
  noOverlapForbidden,
  validateScheduleAssignments,
} from './constraints.js';
import { replaySessionMutations } from './mutation.js';
import { ANNEALING_CONFIG, MUTATION_WEIGHTS, mutateQuestionersOnly, mutateWithStrategies, runAnnealing } from './annealing-strategies.js';
import { repairQuestioners } from './targeted-strategies.js';
import { cloneSessions, hammingDistance } from './strategy-utils.js';
import { generateSessionDates, buildUnavailMap, isISO8601, isWholeGroupClosure } from './utils.js';
import { drrNext, drrRecover, DRRState, vftNext, vftRecover, VFTState } from './wps.js';


// #region Assignment state

function buildNumberedPersonIds(
  sessions: Session[],
  personIds: string[],
) {

  const personReverseMap = new Map<string, number>(personIds.map((id, i) => [id, i]));

  const presenterNumbers = sessions.flatMap(s => s.presentations.map(p => personReverseMap.get(p.presenterId)!));
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
  forbiddenReciprocalQuestioners?: Set<string>,
  assignment?: QuestionerAssignmentPolicy,
  pairCounts?: Map<string, number>,
  questionerCounts?: Map<string, number>,
) {
  const isVetoed = (i: number) => {
    const id = personIds[i];
    return (
      id === presenterId
      || noOverlapForbidden(presenterId, id, guidance)
      || forbiddenReciprocalQuestioners?.has(id)
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
    let preferred: Set<string> | null = null;
    const preferNovelty = !!assignment && assignment.noveltyChance > 0 && Math.random() < assignment.noveltyChance;
    const preferBalance = !!assignment && assignment.balanceChance > 0 && Math.random() < assignment.balanceChance;
    if (preferNovelty || preferBalance) {
      const eligible = personIds.filter((_, index) => !isVetoed(index));
      if (eligible.length && preferNovelty) {
        const fewest = Math.min(...eligible.map(id => pairCounts?.get(`${id}→${presenterId}`) ?? 0));
        preferred = new Set(eligible.filter(id => (pairCounts?.get(`${id}→${presenterId}`) ?? 0) === fewest));
      }
      if (eligible.length && preferBalance) {
        const pool = preferred ? eligible.filter(id => preferred!.has(id)) : eligible;
        const load = (id: string) => (questionerCounts?.get(id) ?? 0) / Math.max(0.01, guidance.questionerWeights.get(id) ?? 1);
        const least = Math.min(...pool.map(load));
        preferred = new Set(pool.filter(id => load(id) <= least + 1e-9));
      }
    }
    const idx = vftNext(vftState, index => isVetoed(index)
      || (preferred !== null && !preferred.has(personIds[index])), weightAdjust);
    if (idx === null) break; // All candidates vetoed
    const selected = personIds[idx];
    questionerIds.push(selected);
    if (pairCounts) {
      const key = `${selected}→${presenterId}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    if (questionerCounts) questionerCounts.set(selected, (questionerCounts.get(selected) ?? 0) + 1);
  }
  return questionerIds;
}

// #endregion

// #region Schedule builder
export class RandomScheduleGenerator {

  private readonly maxPresenters: number;
  private readonly guidance: ReturnType<typeof buildConstraintGuidance>;
  private readonly presenterNumbers: ReturnType<typeof buildNumberedPersonIds>["presenterNumbers"];
  private readonly questionerNumbers: ReturnType<typeof buildNumberedPersonIds>["questionerNumbers"];
  private readonly drrState: ReturnType<typeof drrRecover>;
  private readonly vftStateQuestioner: ReturnType<typeof vftRecover>;
  private readonly pairCounts = new Map<string, number>();
  private readonly questionerCounts = new Map<string, number>();

  constructor(
    private readonly personIds: string[],
    private readonly config: ScheduleConfig,
    private readonly ctx: CostContext,
    historicalSessions: Session[] = [],
    private readonly unavailMap: Map<string, Set<string>> = new Map(),
  ) {
    this.maxPresenters = Math.min(config.presentersPerSession, personIds.length);
    this.guidance = buildConstraintGuidance(ctx);

    const { presenterNumbers, questionerNumbers } = buildNumberedPersonIds(historicalSessions, personIds);
    this.presenterNumbers = presenterNumbers;
    this.questionerNumbers = questionerNumbers;
    for (const session of historicalSessions) for (const presentation of session.presentations)
      for (const id of presentation.questionerIds) {
        const key = `${id}→${presentation.presenterId}`;
        this.pairCounts.set(key, (this.pairCounts.get(key) ?? 0) + 1);
        this.questionerCounts.set(id, (this.questionerCounts.get(id) ?? 0) + 1);
      }

    const weights = personIds.map(id => this.guidance.presenterWeights?.get(id) ?? 1);
    this.drrState = drrRecover(
      this.presenterNumbers,
      weights,
      undefined,
      0.04,
    );

    const weightsQuestioner = personIds.map(id => this.guidance.questionerWeights?.get(id) ?? 1);
    this.vftStateQuestioner = vftRecover(
      this.questionerNumbers,
      weightsQuestioner,
      undefined,
      0.1,
    );
  }

  similarityFactor(presenterId: string, questionerId: string): number {
    const similarityFactorScaleBottom = 0.2;
    const similarityFactorScaleTop = 0.6;

    const rawSimilarity = getPersonSimilarity(
      this.ctx.personKeywords.get(presenterId) ?? [],
      this.ctx.personKeywords.get(questionerId) ?? [],
      this.ctx.similarities,
    );
    const diff = Math.abs(rawSimilarity - this.ctx.r);
    const scaledDiff = (diff - similarityFactorScaleBottom) / (similarityFactorScaleTop - similarityFactorScaleBottom);
    return Math.min(Math.max(0, 1 - scaledDiff), 1);
  }

  generate(date: string, maxPresentersOverride?: number): Presentation[] {
    const unavail = this.unavailMap.get(date) ?? new Set<string>();
    const n = Math.min(maxPresentersOverride ?? this.maxPresenters, this.personIds.length - unavail.size);
    if (n === 0) {
      throw new Error(`No eligible presenters are available on ${date}`);
    }

    const presenters = choosePresenters(this.personIds, n, this.drrState, id => unavail.has(id));

    const presentations: Presentation[] = [];

    for (const presenterId of presenters) {
      const questionerIds = chooseQuestioners(
        presenterId,
        this.personIds,
        this.config.questionersPerPresenter,
        (presenterId, questionerId) => this.similarityFactor(presenterId, questionerId),
        this.vftStateQuestioner,
        this.guidance,
        id => unavail.has(id),
        this.ctx.reciprocalPreference === 'forbid'
          ? new Set(presentations.filter(previous => previous.questionerIds.includes(presenterId)).map(previous => previous.presenterId))
          : undefined,
        this.ctx.questionerOptimization.assignment,
        this.pairCounts,
        this.questionerCounts,
      );

      presentations.push({ presenterId, questionerIds });
    }

    return presentations;
  }
}

export function buildRandomSchedule(
  personIds: string[],
  dates: string[],
  config: ScheduleConfig,
  ctx: CostContext,
  historicalSessions: Session[] = [],
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  if (personIds.length === 0) {
    return dates.map(date => ({ date, presentations: [] }));
  }

  const builder = new RandomScheduleGenerator(personIds, config, ctx, historicalSessions, unavailMap);
  const sessions: Session[] = [];

  for (let si = 0; si < dates.length; si++) {
    const date = dates[si];
    sessions.push({ date, presentations: builder.generate(date) });
  }

  return sessions;
}

function buildQuestionerPicker(
  personIds: string[],
  ctx: CostContext,
  guidance: ConstraintGuidance,
  unavailMap: Map<string, Set<string>>,
  historicalSessions: Session[] = [],
  assignment?: QuestionerAssignmentPolicy,
  random: () => number = Math.random,
): (presenterId: string, date: string, count: number, forbidden?: Set<string>) => string[] {
  const pairCounts = new Map<string, number>();
  const questionerCounts = new Map<string, number>();
  for (const session of historicalSessions) for (const presentation of session.presentations)
    for (const questioner of presentation.questionerIds) {
      const key = `${questioner}→${presentation.presenterId}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      questionerCounts.set(questioner, (questionerCounts.get(questioner) ?? 0) + 1);
    }
  const simFactor = (presenterId: string, questionerId: string): number => {
    const rawSim = getPersonSimilarity(
      ctx.personKeywords.get(presenterId) ?? [],
      ctx.personKeywords.get(questionerId) ?? [],
      ctx.similarities,
    );
    const diff = Math.abs(rawSim - ctx.r);
    const scaled = (diff - 0.2) / 0.4;
    return Math.min(Math.max(0, 1 - scaled), 1);
  };

  return (presenterId: string, date: string, count: number, forbidden?: Set<string>): string[] => {
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const pool = personIds.filter(
      id => id !== presenterId && !unavail.has(id) && !forbidden?.has(id) && !noOverlapForbidden(presenterId, id, guidance),
    );
    const picked: string[] = [];
    const used = new Set<string>();

    for (let j = 0; j < count; j++) {
      let avail = pool.filter(id => !used.has(id));
      if (!avail.length) break;
      if (assignment && assignment.noveltyChance > 0 && random() < assignment.noveltyChance) {
        const fewest = Math.min(...avail.map(id => pairCounts.get(`${id}→${presenterId}`) ?? 0));
        avail = avail.filter(id => (pairCounts.get(`${id}→${presenterId}`) ?? 0) === fewest);
      }
      if (assignment && assignment.balanceChance > 0 && random() < assignment.balanceChance) {
        const load = (id: string) => (questionerCounts.get(id) ?? 0) / Math.max(0.01, guidance.questionerWeights.get(id) ?? 1);
        const least = Math.min(...avail.map(load));
        avail = avail.filter(id => load(id) <= least + 1e-9);
      }
      const weights = avail.map(id =>
        Math.max(0.01, affinityPairWeight(presenterId, id, guidance) * simFactor(presenterId, id)),
      );
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let cursor = random() * total;
      let chosen = avail.length - 1;
      for (let k = 0; k < weights.length; k++) {
        cursor -= weights[k];
        if (cursor <= 0) {
          chosen = k;
          break;
        }
      }
      const selected = avail[chosen]!;
      used.add(selected);
      picked.push(selected);
      const pairKey = `${selected}→${presenterId}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
      questionerCounts.set(selected, (questionerCounts.get(selected) ?? 0) + 1);
    }

    return picked;
  };
}

function rebuildQuestionersForSessions(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>> = new Map(),
  historicalSessions: Session[] = [],
): Session[] {
  const guidance = buildConstraintGuidance(ctx);
  const pickQuestioners = buildQuestionerPicker(personIds, ctx, guidance, unavailMap,
    historicalSessions, ctx.questionerOptimization.assignment);
  const next = cloneSessions(sessions);

  for (const session of next) {
    const assigned: Presentation[] = [];
    for (const presentation of session.presentations) {
      const count = presentation.questionerIds.length || config.questionersPerPresenter;
      const forbidden = ctx.reciprocalPreference === 'forbid'
        ? new Set(assigned.filter(previous => previous.questionerIds.includes(presentation.presenterId)).map(previous => previous.presenterId))
        : undefined;
      presentation.questionerIds = pickQuestioners(presentation.presenterId, session.date, count, forbidden);
      assigned.push(presentation);
    }
  }

  return next;
}

// #endregion

// #region Annealing

export function mutate(
  sessions: Session[], personIds: string[], ctx: CostContext, guidance: ConstraintGuidance,
  historicalSessions: Session[], config: ScheduleConfig,
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  const random = Math.random;
  return mutateWithStrategies({
    sessions, personIds, cost: ctx, guidance, historicalSessions, config,
    unavailable: unavailMap, random,
    pickQuestioners: buildQuestionerPicker(personIds, ctx, guidance, unavailMap, [], undefined, random),
  }, MUTATION_WEIGHTS);
}

export function simulatedAnnealing(
  initial: Session[], ctx: CostContext, historicalSessions: Session[], config: ScheduleConfig,
  hammingRef: Session[] | null, hammingWeight: number,
  unavailMap: Map<string, Set<string>> = new Map(),
  maxIter = ANNEALING_CONFIG.maxIter, diagnostics?: SolverDiagnostics,
): Session[] {
  const guidance = buildConstraintGuidance(ctx);
  return runAnnealing({
    initial, cost: ctx, guidance, historicalSessions, unavailable: unavailMap,
    reference: hammingRef, referenceWeight: hammingWeight, random: Math.random,
    maxIterations: maxIter, diagnostics,
    propose: current => mutate(current, [...ctx.personKeywords.keys()], ctx, guidance,
      historicalSessions, config, unavailMap),
  });
}

export function simulatedAnnealingQuestionersOnly(
  initial: Session[], ctx: CostContext, historicalSessions: Session[], config: ScheduleConfig,
  hammingRef: Session[] | null, hammingWeight: number,
  unavailMap: Map<string, Set<string>> = new Map(),
  maxIter = ANNEALING_CONFIG.maxIter, diagnostics?: SolverDiagnostics,
): Session[] {
  const guidance = buildConstraintGuidance(ctx);
  const personIds = [...ctx.personKeywords.keys()];
  const random = Math.random;
  return runAnnealing({
    initial, cost: ctx, guidance, historicalSessions, unavailable: unavailMap,
    reference: hammingRef, referenceWeight: hammingWeight, random,
    maxIterations: maxIter, diagnostics,
    propose: sessions => mutateQuestionersOnly({
      sessions, personIds, cost: ctx, guidance, historicalSessions, config,
      unavailable: unavailMap, random,
      pickQuestioners: buildQuestionerPicker(personIds, ctx, guidance, unavailMap, [], undefined, random),
    }),
  });
}

export const annealingSolver: ScheduleSolver = {
  solveFull(input: SolverInput): Session[] {
    const { config, unavailabilities = [], mutations } = input;
    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const dates = generateSessionDates(config);
    if (mutations?.length) {
      replaySessionMutations(dates, mutations, { inPlace: true });
    }
    const openDates = dates.filter(date => !isWholeGroupClosure(date, unavailabilities, config.id));
    if (openDates.length === 0) {
      if (input.diagnostics) Object.assign(input.diagnostics, { initialCost: 0, finalCost: 0, iterations: 0,
        accepted: 0, invalidNeighbors: 0, unchangedNeighbors: 0, durationMs: 0, restarts: 0 });
      return [];
    }

    const unavailMap = buildUnavailMap(unavailabilities, config.id, input.persons, openDates);

    const guidance = buildConstraintGuidance(ctx);
    let best: Session[] | null = null;
    let bestCost = Infinity;
    const diagnostics: SolverDiagnostics[] = [];
    for (let restart = 0; restart < 2; restart++) {
      const initial = buildRandomSchedule(personIds, openDates, config, ctx, [], unavailMap);
      const run = {} as SolverDiagnostics;
      const optimized = simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap, ANNEALING_CONFIG.maxIter, run);
      const repairStarted = performance.now();
      const repaired = repairQuestioners(optimized, [], ctx, guidance, unavailMap, Math.random);
      run.durationMs += Math.round(performance.now() - repairStarted);
      const cost = computeCost(repaired, ctx, guidance);
      run.finalCost = cost;
      diagnostics.push(run);
      if (cost < bestCost) { best = repaired; bestCost = cost; }
    }
    const result = best ?? [];
    const violations = validateScheduleAssignments(result, input);
    if (violations.length) throw new Error(violations[0]);
    if (input.diagnostics) Object.assign(input.diagnostics, {
      initialCost: diagnostics.reduce((minimum, run) => Math.min(minimum, run.initialCost), Infinity),
      finalCost: bestCost,
      iterations: diagnostics.reduce((total, run) => total + run.iterations, 0),
      accepted: diagnostics.reduce((total, run) => total + run.accepted, 0),
      invalidNeighbors: diagnostics.reduce((total, run) => total + run.invalidNeighbors, 0),
      unchangedNeighbors: diagnostics.reduce((total, run) => total + run.unchangedNeighbors, 0),
      durationMs: diagnostics.reduce((total, run) => total + run.durationMs, 0), restarts: diagnostics.length,
    });
    return result;
  },

  /**
   * Re-schedule sessions from changeDate onward, minimizing divergence from the
   * previous plan via a Hamming penalty.
   */
  solveIncremental(input: IncrementalSolverInput): Session[] {
    const {
      config, sessions, mutations,
      index: _index, changeDate: _changeDate, unavailabilities = [],
      mode = 'full',
      useHamming = true,
    } = input;

    if (_index == null && (_changeDate == null || !isISO8601(_changeDate))) {
      throw new Error('Invalid incremental input: must provide either index or valid changeDate');
    }
    const changeDate = _changeDate ?? sessions[_index!].date;
    const index = _index ?? sessions.findIndex(s => s.date >= changeDate);
    if (index === -1) {
      // No sessions on or after changeDate; return previous plan unchanged.
      return sessions;
    }

    const frozenSessions = sessions.slice(0, index);
    const activeSessions = sessions.slice(index).filter(session => !isWholeGroupClosure(session.date, unavailabilities, config.id));

    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const hammingRef = useHamming ? activeSessions : null;

    if (mode === 'questioners-only') {
      if (activeSessions.length === 0) return frozenSessions;
      const unavailMap = buildUnavailMap(unavailabilities, config.id, input.persons, activeSessions.map(session => session.date));
      const run = {} as SolverDiagnostics;
      const initial = rebuildQuestionersForSessions(activeSessions, personIds, ctx, config, unavailMap, frozenSessions);
      const optimized = simulatedAnnealingQuestionersOnly(
        initial,
        ctx,
        frozenSessions,
        config,
        hammingRef,
        ANNEALING_CONFIG.hammingWeight,
        unavailMap,
        ANNEALING_CONFIG.maxIter,
        run,
      );
      const repairStarted = performance.now();
      const repaired = repairQuestioners(optimized, frozenSessions, ctx, buildConstraintGuidance(ctx), unavailMap, Math.random);
      run.durationMs += Math.round(performance.now() - repairStarted);
      run.finalCost = computeCost(repaired, ctx, buildConstraintGuidance(ctx), frozenSessions);

      const violations = validateScheduleAssignments(repaired, input);
      if (violations.length) throw new Error(violations[0]);
      if (input.diagnostics) Object.assign(input.diagnostics, run);
      return frozenSessions.concat(repaired);
    }

    const mutableDates = generateSessionDates({ ...config, startDate: changeDate });
    if (mutations?.length) {
      replaySessionMutations(mutableDates, mutations, { inPlace: true, startDate: changeDate });
    }
    const openDates = mutableDates.filter(date => !isWholeGroupClosure(date, unavailabilities, config.id));
    if (openDates.length === 0) {
      if (input.diagnostics) Object.assign(input.diagnostics, { initialCost: 0, finalCost: 0, iterations: 0,
        accepted: 0, invalidNeighbors: 0, unchangedNeighbors: 0, durationMs: 0, restarts: 0 });
      return frozenSessions;
    }

    const guidance = buildConstraintGuidance(ctx);
    const unavailMap = buildUnavailMap(unavailabilities, config.id, input.persons, openDates);
    let best: Session[] | null = null;
    let bestCost = Infinity;
    const diagnostics: SolverDiagnostics[] = [];
    for (let restart = 0; restart < 2; restart++) {
      const initial = buildRandomSchedule(personIds, openDates, config, ctx, frozenSessions, unavailMap);
      const run = {} as SolverDiagnostics;
      const optimized = simulatedAnnealing(
        initial, ctx, frozenSessions, config,
        hammingRef, ANNEALING_CONFIG.hammingWeight, unavailMap, ANNEALING_CONFIG.maxIter, run,
      );
      const repairStarted = performance.now();
      const repaired = repairQuestioners(optimized, frozenSessions, ctx, guidance, unavailMap, Math.random);
      run.durationMs += Math.round(performance.now() - repairStarted);
      const cost = computeCost(repaired, ctx, guidance, frozenSessions)
        + (hammingRef ? ANNEALING_CONFIG.hammingWeight * hammingDistance(repaired, hammingRef) : 0);
      run.finalCost = cost;
      diagnostics.push(run);
      if (cost < bestCost) { best = repaired; bestCost = cost; }
    }
    const result = best ?? [];
    const violations = validateScheduleAssignments(result, input);
    if (violations.length) throw new Error(violations[0]);
    if (input.diagnostics) Object.assign(input.diagnostics, {
      initialCost: diagnostics.reduce((minimum, run) => Math.min(minimum, run.initialCost), Infinity),
      finalCost: bestCost,
      iterations: diagnostics.reduce((total, run) => total + run.iterations, 0),
      accepted: diagnostics.reduce((total, run) => total + run.accepted, 0),
      invalidNeighbors: diagnostics.reduce((total, run) => total + run.invalidNeighbors, 0),
      unchangedNeighbors: diagnostics.reduce((total, run) => total + run.unchangedNeighbors, 0),
      durationMs: diagnostics.reduce((total, run) => total + run.durationMs, 0), restarts: diagnostics.length,
    });
    return frozenSessions.concat(result);
  },
}

// #endregion
