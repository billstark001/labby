/**
 * Schedule builder and simulated annealing optimizer.
 *
 * Mutation strategies and annealing hyperparameters are tunable via
 * MUTATION_WEIGHTS and ANNEALING_CONFIG.
 */

import { getPersonSimilarity } from '../nlp.js';
import type { Session, Presentation, ScheduleConfig, ScheduleSolver, IncrementalSolverInput, SolverInput } from '../types.js';
import {
  type CostContext,
  computeCost,
  buildCostContext,
  affinityPairWeight,
  buildConstraintGuidance,
  ConstraintGuidance,
  noOverlapForbidden,
} from './constraints.js';
import { replaySessionMutations } from './mutation.js';
import { generateSessionDates, buildUnavailMap, isISO8601 } from './utils.js';
import { drrNext, drrRecover, DRRState, vftNext, vftRecover, VFTState } from './wps.js';

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


// #endregion

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
export class RandomScheduleGenerator {

  private readonly maxPresenters: number;
  private readonly guidance: ReturnType<typeof buildConstraintGuidance>;
  private readonly presenterNumbers: ReturnType<typeof buildNumberedPersonIds>["presenterNumbers"];
  private readonly questionerNumbers: ReturnType<typeof buildNumberedPersonIds>["questionerNumbers"];
  private readonly drrState: ReturnType<typeof drrRecover>;
  private readonly vftStateQuestioner: ReturnType<typeof vftRecover>;

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
      return [];
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

// #endregion

// #region Annealing

export function mutate(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  guidance: ConstraintGuidance,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  if (!sessions.length) return sessions;
  const clone = deepCloneSessions(sessions);
  if (!personIds.length) return clone;

  const allSessions = [...historicalSessions, ...clone];

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /** Similarity-based questioner weight, matching buildRandomSchedule logic. */
  const simFactor = (pid: string, qid: string): number => {
    const rawSim = getPersonSimilarity(
      ctx.personKeywords.get(pid) ?? [],
      ctx.personKeywords.get(qid) ?? [],
      ctx.similarities,
    );
    const diff = Math.abs(rawSim - ctx.r);
    const scaled = (diff - 0.2) / 0.4;
    return Math.min(Math.max(0, 1 - scaled), 1);
  };

  /** Pick `count` questioners for `presenterId` at `date` via weighted sampling. */
  const pickQuestioners = (presenterId: string, date: string, count: number): string[] => {
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const pool = personIds.filter(
      id => id !== presenterId && !unavail.has(id) && !noOverlapForbidden(presenterId, id, guidance),
    );
    const picked: string[] = [];
    const used = new Set<string>();
    for (let j = 0; j < count; j++) {
      const avail = pool.filter(id => !used.has(id));
      if (!avail.length) break;
      const weights = avail.map(id =>
        Math.max(0.01, affinityPairWeight(presenterId, id, guidance) * simFactor(presenterId, id)),
      );
      const total = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * total;
      let chosen = avail.length - 1;
      for (let k = 0; k < weights.length; k++) {
        r -= weights[k];
        if (r <= 0) { chosen = k; break; }
      }
      used.add(avail[chosen]);
      picked.push(avail[chosen]);
    }
    return picked;
  };

  /** Raw (unscaled) per-person presenter appearance counts across allSessions. */
  const rawPresenterCounts = (): Map<string, number> => {
    const counts = new Map<string, number>(personIds.map(id => [id, 0]));
    for (const s of allSessions) {
      for (const p of s.presentations) {
        counts.set(p.presenterId, (counts.get(p.presenterId) ?? 0) + 1);
      }
    }
    return counts;
  };

  /** Expected appearances per person derived from frequency-multiplier weights. */
  const expectedCounts = (total: number): Map<string, number> => {
    const freqWeights = personIds.map(id => guidance.presenterWeights?.get(id) ?? 1);
    const totalFreq = freqWeights.reduce((s, w) => s + w, 0);
    return new Map(personIds.map((id, i) => [id, totalFreq > 0 ? total * freqWeights[i] / totalFreq : total / personIds.length]));
  };

  // ── Strategy selection ─────────────────────────────────────────────────────
  const strategies = Object.entries(MUTATION_WEIGHTS) as [keyof typeof MUTATION_WEIGHTS, number][];
  const totalWeight = strategies.reduce((s, [, w]) => s + w, 0);
  let pick = Math.random() * totalWeight;
  let strategy: keyof typeof MUTATION_WEIGHTS = strategies[0][0];
  for (const [k, w] of strategies) {
    pick -= w;
    if (pick <= 0) { strategy = k; break; }
  }

  switch (strategy) {

    // ── 1. Swap entire presentation slots between two random sessions ────────
    // Improves presentation-gap uniformity and load balance simultaneously;
    // rebuilds questioners for the relocated presenter.
    case 'swapPresenters': {
      const eligible = clone.filter(s => s.presentations.length > 0);
      if (eligible.length < 2) break;
      for (let attempt = 0; attempt < 20; attempt++) {
        const ia = Math.floor(Math.random() * eligible.length);
        let ib = Math.floor(Math.random() * (eligible.length - 1));
        if (ib >= ia) ib++;
        const sessA = eligible[ia];
        const sessB = eligible[ib];
        const pi = Math.floor(Math.random() * sessA.presentations.length);
        const pj = Math.floor(Math.random() * sessB.presentations.length);
        const idA = sessA.presentations[pi].presenterId;
        const idB = sessB.presentations[pj].presenterId;
        if (idA === idB) continue;
        const unavailA = unavailMap.get(sessA.date) ?? new Set<string>();
        const unavailB = unavailMap.get(sessB.date) ?? new Set<string>();
        if (unavailA.has(idB) || unavailB.has(idA)) continue;
        const inA = new Set(sessA.presentations.map(p => p.presenterId));
        const inB = new Set(sessB.presentations.map(p => p.presenterId));
        if (inB.has(idA) || inA.has(idB)) continue;
        // Swap presenter ids; rebuild questioners for each moved presenter.
        sessA.presentations[pi].presenterId = idB;
        sessB.presentations[pj].presenterId = idA;
        sessA.presentations[pi].questionerIds = pickQuestioners(
          idB, sessA.date, sessA.presentations[pi].questionerIds.length || config.questionersPerPresenter,
        );
        sessB.presentations[pj].questionerIds = pickQuestioners(
          idA, sessB.date, sessB.presentations[pj].questionerIds.length || config.questionersPerPresenter,
        );
        break;
      }
      break;
    }

    // ── 2. Reassign questioners for one presentation ─────────────────────────
    // Targets the relevance and questioner-frequency penalties without
    // disturbing the presenter assignment.
    case 'reassignQuestioners': {
      const eligible = clone.filter(s => s.presentations.length > 0);
      if (!eligible.length) break;
      const sess = eligible[Math.floor(Math.random() * eligible.length)];
      const pres = sess.presentations[Math.floor(Math.random() * sess.presentations.length)];
      const count = pres.questionerIds.length || config.questionersPerPresenter;
      pres.questionerIds = pickQuestioners(pres.presenterId, sess.date, count);
      break;
    }

    // ── 3. Replace presenter with most under-represented eligible person ─────
    // Directly reduces presenterLoad variance by inserting an under-represented
    // person and ejecting their slot (rebuilt questioners follow).
    case 'replacePresenter': {
      const eligible = clone.filter(s => s.presentations.length > 0);
      if (!eligible.length) break;
      const sess = eligible[Math.floor(Math.random() * eligible.length)];
      const pIdx = Math.floor(Math.random() * sess.presentations.length);
      const unavail = unavailMap.get(sess.date) ?? new Set<string>();
      const inSession = new Set(sess.presentations.map(p => p.presenterId));
      const counts = rawPresenterCounts();
      const totalObs = personIds.reduce((s, id) => s + (counts.get(id) ?? 0), 0);
      const expected = expectedCounts(totalObs);
      const candidates = personIds.filter(id => !unavail.has(id) && !inSession.has(id));
      if (!candidates.length) break;
      // Sort ascending by (actual - expected): most under-represented at front.
      candidates.sort((a, b) =>
        ((counts.get(a) ?? 0) - (expected.get(a) ?? 0)) -
        ((counts.get(b) ?? 0) - (expected.get(b) ?? 0)),
      );
      // Pick randomly from the most under-represented third.
      const pool = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.33)));
      const replacement = pool[Math.floor(Math.random() * pool.length)];
      const pres = sess.presentations[pIdx];
      pres.presenterId = replacement;
      pres.questionerIds = pickQuestioners(
        replacement, sess.date, pres.questionerIds.length || config.questionersPerPresenter,
      );
      break;
    }

    // ── 4. Targeted frequency-multiplier deviation fix ───────────────────────
    // Finds the person deviating most from their frequency-multiplier target
    // (over-represented) and swaps them with the most under-represented person
    // in one presentation slot.
    case 'frequencyTargeted': {
      if (!allSessions.length) break;
      const counts = rawPresenterCounts();
      const totalObs = personIds.reduce((s, id) => s + (counts.get(id) ?? 0), 0);
      const expected = expectedCounts(totalObs);
      const deviations = personIds.map(id => ({
        id,
        dev: (counts.get(id) ?? 0) - (expected.get(id) ?? 0),
      }));
      deviations.sort((a, b) => a.dev - b.dev);
      const underRep = deviations[0];   // most under-represented
      const overRep = deviations[deviations.length - 1]; // most over-represented
      // Skip if already balanced (deviation < 1 presentation).
      if (overRep.dev < 1 || underRep.dev > -1) break;
      for (let attempt = 0; attempt < 30; attempt++) {
        const si = Math.floor(Math.random() * clone.length);
        const sess = clone[si];
        const unavail = unavailMap.get(sess.date) ?? new Set<string>();
        if (unavail.has(underRep.id)) continue;
        const overIdx = sess.presentations.findIndex(p => p.presenterId === overRep.id);
        if (overIdx === -1) continue;
        const inSession = new Set(sess.presentations.map(p => p.presenterId));
        if (inSession.has(underRep.id)) continue;
        const pres = sess.presentations[overIdx];
        pres.presenterId = underRep.id;
        pres.questionerIds = pickQuestioners(
          underRep.id, sess.date, pres.questionerIds.length || config.questionersPerPresenter,
        );
        break;
      }
      break;
    }

    // ── 5. Fully rebuild one session's assignments ───────────────────────────
    // Escapes deep local optima by regenerating all presenter + questioner
    // assignments for a single session, weighted toward under-represented people.
    case 'sessionRebuild': {
      const eligible = clone.filter(s => s.presentations.length > 0);
      if (!eligible.length) break;
      const sess = eligible[Math.floor(Math.random() * eligible.length)];
      const unavail = unavailMap.get(sess.date) ?? new Set<string>();
      // Exclude this session's contributions from counts so the rebuild is fair.
      const counts = rawPresenterCounts();
      for (const p of sess.presentations) {
        counts.set(p.presenterId, Math.max(0, (counts.get(p.presenterId) ?? 1) - 1));
      }
      const totalObs = personIds.reduce((s, id) => s + (counts.get(id) ?? 0), 0);
      const n = sess.presentations.length;
      const expected = expectedCounts(totalObs + n);
      const candidates = personIds.filter(id => !unavail.has(id));
      if (candidates.length < n) break;
      const pickedPresenters = new Set<string>();
      const newPresentations: Presentation[] = [];
      for (let j = 0; j < n; j++) {
        const pool = candidates.filter(id => !pickedPresenters.has(id));
        if (!pool.length) break;
        // Weight: how many more appearances the person "deserves" vs current count.
        const weights = pool.map(id =>
          Math.max(0.01, (expected.get(id) ?? 1) - (counts.get(id) ?? 0)),
        );
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        let chosen = pool.length - 1;
        for (let k = 0; k < weights.length; k++) {
          r -= weights[k];
          if (r <= 0) { chosen = k; break; }
        }
        const presenterId = pool[chosen];
        pickedPresenters.add(presenterId);
        newPresentations.push({
          presenterId,
          questionerIds: pickQuestioners(presenterId, sess.date, config.questionersPerPresenter),
        });
      }
      sess.presentations = newPresentations;
      break;
    }
  }

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
  const guidance = buildConstraintGuidance(ctx);

  const personIds = [...ctx.personKeywords.keys()];
  const totalCost = (s: Session[]) =>
    computeCost(s, ctx, guidance, historicalSessions) +
    (hammingRef ? hammingWeight * hammingDistance(s, hammingRef) : 0);

  let current = deepCloneSessions(initial);
  let currentCost = totalCost(current);
  let best = deepCloneSessions(current);
  let bestCost = currentCost;

  for (let iter = 0; iter < maxIter; iter++) {
    const temp = ANNEALING_CONFIG.initialTemp * ANNEALING_CONFIG.coolingRate ** iter;
    const neighbor = mutate(current, personIds, ctx, guidance, historicalSessions, config, unavailMap);
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
  solveFull(input: SolverInput): Session[] {
    const { config, unavailabilities = [], mutations } = input;
    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const dates = generateSessionDates(config);
    if (mutations?.length) {
      replaySessionMutations(dates, mutations, { inPlace: true });
    }

    const unavailMap = buildUnavailMap(unavailabilities, config.id);

    const initial = buildRandomSchedule(personIds, dates, config, ctx, [], unavailMap);
    const optimized = simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap);

    return optimized;
  },

  /**
   * Re-schedule sessions from changeDate onward, minimizing divergence from the
   * previous plan via a Hamming penalty.
   */
  solveIncremental(input: IncrementalSolverInput): Session[] {
    const {
      config, sessions, mutations,
      index: _index, changeDate: _changeDate, unavailabilities = [],
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
    const activeSessions = sessions.slice(index);
    const mutableDates = generateSessionDates({ ...config, startDate: changeDate });
    if (mutations?.length) {
      replaySessionMutations(mutableDates, mutations, { inPlace: true, startDate: changeDate });
    }

    const ctx = buildCostContext(input);
    const personIds = [...ctx.personKeywords.keys()];
    const unavailMap = buildUnavailMap(unavailabilities, config.id);
    const hammingRef = useHamming ? activeSessions : null;

    const initial = buildRandomSchedule(personIds, mutableDates, config, ctx, frozenSessions, unavailMap);
    const optimized = simulatedAnnealing(
      initial, ctx, frozenSessions, config,
      hammingRef, ANNEALING_CONFIG.hammingWeight, unavailMap,
    );

    return frozenSessions.concat(optimized);
  },
}

// #endregion