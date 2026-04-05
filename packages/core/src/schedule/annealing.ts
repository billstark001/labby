/**
 * Schedule builder and simulated annealing optimizer.
 *
 * Mutation strategies and annealing hyperparameters are tunable via
 * MUTATION_WEIGHTS and ANNEALING_CONFIG.
 */

import type { Session, Presentation, ScheduleConfig, ScheduleSolver, IncrementalSolverInput, SchedulePlan, SolverInput } from '../types.js';
import {
  type CostContext,
  incrementCount,
  personSimilarity,
  computeCost,
  buildCostContext,
} from './constraints.js';
import { generateSessionDates, generateId } from './index.js';
import { buildUnavailMap, replaySessionMutationDates } from './utils.js';

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

interface AssignmentState {
  presenterCounts: Map<string, number>;
  questionerCounts: Map<string, number>;
  totalRoleCounts: Map<string, number>;
  pairCounts: Map<string, number>;
  lastPresentationIndex: Map<string, number>;
}

interface PresentationTarget {
  sessionIndex: number;
  presentationIndex: number;
}

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

// #endregion

// #region Assignment state

function buildAssignmentState(
  personIds: string[],
  historicalSessions: Session[],
  guidance: ConstraintGuidance,
  currentSessions: Session[] = [],
  excludedTargets = new Set<string>(),
): AssignmentState {
  const presenterCounts = new Map<string, number>();
  const questionerCounts = new Map<string, number>();
  const totalRoleCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const lastPresentationIndex = new Map<string, number>();

  for (const id of personIds) {
    presenterCounts.set(id, 0);
    questionerCounts.set(id, 0);
    totalRoleCounts.set(id, 0);
  }

  const register = (p: Presentation, absIdx: number, includeQ: boolean) => {
    const presenterInc = frequencyRoleFactor(p.presenterId, 'presenter', guidance);
    incrementCount(presenterCounts, p.presenterId, presenterInc);
    incrementCount(totalRoleCounts, p.presenterId, presenterInc);
    lastPresentationIndex.set(p.presenterId, absIdx);
    if (!includeQ) return;
    for (const q of p.questionerIds) {
      const questionerInc =
        frequencyRoleFactor(q, 'questioner', guidance)
        * affinityPairFactor(p.presenterId, q, guidance);
      incrementCount(questionerCounts, q, questionerInc);
      incrementCount(totalRoleCounts, q, questionerInc);
      incrementCount(pairCounts, `${q}→${p.presenterId}`);
    }
  };

  historicalSessions.forEach((s, i) => {
    for (const p of s.presentations) register(p, i, true);
  });

  const base = historicalSessions.length;
  currentSessions.forEach((s, si) => {
    s.presentations.forEach((p, pi) => {
      register(p, base + si, !excludedTargets.has(`${si}:${pi}`));
    });
  });

  return { presenterCounts, questionerCounts, totalRoleCounts, pairCounts, lastPresentationIndex };
}

function choosePresenters(
  availableIds: string[],
  count: number,
  state: AssignmentState,
  guidance: ConstraintGuidance,
): string[] {
  if (count <= 0 || availableIds.length === 0) return [];
  const n = Math.min(count, availableIds.length);

  // Priority (ascending = more desirable):
  // 1. fewer past presenter assignments
  // 2. fewer total role assignments
  // 3. longer time since last presentation (lower lastPresentationIndex)
  // 4. random tie-breaker
  const scored = availableIds.map(id => ({
    id,
    pc: state.presenterCounts.get(id) ?? 0,
    tc: state.totalRoleCounts.get(id) ?? 0,
    lastIdx: state.lastPresentationIndex.get(id) ?? -1,
    jitter: Math.random(),
  }));

  scored.sort((a, b) => {
    const jitterDiff = (a.jitter - b.jitter) / 2;
    const pcDiff = a.pc - b.pc;
    if (Math.abs(pcDiff) > 1e-9) return pcDiff + jitterDiff;
    const tcDiff = a.tc - b.tc;
    if (Math.abs(tcDiff) > 1e-9) return tcDiff + jitterDiff;
    const gapDiff = a.lastIdx - b.lastIdx;
    if (Math.abs(gapDiff) > 1e-9) return gapDiff + jitterDiff;
    return jitterDiff;
  });

  return scored.slice(0, n).map(x => x.id);
}

function chooseQuestioners(
  presenterId: string,
  availableIds: string[],
  desiredCount: number,
  state: AssignmentState,
  sessionQuestionerCounts: Map<string, number>,
  ctx: CostContext,
  guidance: ConstraintGuidance,
): string[] {
  if (desiredCount <= 0) return [];

  // Hard constraints: cannot self-question; no-overlap group members excluded.
  const candidates = availableIds.filter(
    id => id !== presenterId && !noOverlapForbidden(presenterId, id, guidance),
  );

  const presenterKeywords = ctx.personKeywords.get(presenterId) ?? [];

  // Priority (ascending = more desirable):
  // 1. fewer past questioner assignments
  // 2. fewer total role assignments
  // 3. lower same-session questioner load
  // 4. fewer repeated (questioner → presenter) pairs
  // 5. similarity closer to target radius r
  // 6. random tie-breaker
  const scored = candidates.map(id => {
    const qc = state.questionerCounts.get(id) ?? 0;
    const tc = state.totalRoleCounts.get(id) ?? 0;
    const sc = sessionQuestionerCounts.get(id) ?? 0;
    const pc = state.pairCounts.get(`${id}→${presenterId}`) ?? 0;
    const qKeywords = ctx.personKeywords.get(id) ?? [];
    const sim = personSimilarity(presenterKeywords, qKeywords, ctx.similarities);
    const relevance = Math.abs(sim - ctx.r);
    return { id, qc, tc, sc, pc, relevance, jitter: Math.random() };
  });

  scored.sort((a, b) => {
    const jitterDiff = (a.jitter - b.jitter) / 2;
    const qcDiff = a.qc - b.qc;
    if (Math.abs(qcDiff) > 1e-9) return qcDiff + jitterDiff;
    const tcDiff = a.tc - b.tc;
    if (Math.abs(tcDiff) > 1e-9) return tcDiff + jitterDiff;
    if (a.sc !== b.sc) return a.sc - b.sc;
    if (a.pc !== b.pc) return a.pc - b.pc;
    const relDiff = a.relevance - b.relevance;
    if (Math.abs(relDiff) > 1e-9) return relDiff + jitterDiff;
    return jitterDiff;
  });

  return scored.slice(0, Math.min(desiredCount, scored.length)).map(x => x.id);
}

// #endregion

// #region Targeted repairs

function repairQuestionersForTargets(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
  targets: PresentationTarget[],
): void {
  if (targets.length === 0) return;
  const excluded = new Set(targets.map(t => `${t.sessionIndex}:${t.presentationIndex}`));
  const guidance = buildConstraintGuidance(ctx);
  const state = buildAssignmentState(personIds, historicalSessions, guidance, sessions, excluded);

  for (const { sessionIndex, presentationIndex } of targets) {
    const sess = sessions[sessionIndex];
    const pres = sess?.presentations[presentationIndex];
    if (!sess || !pres) continue;

    const sqc = new Map<string, number>();
    sess.presentations.forEach((p, pi) => {
      if (pi === presentationIndex) return;
      for (const q of p.questionerIds) incrementCount(sqc, q);
    });

    const unavail = unavailMap.get(sess.date) ?? new Set<string>();
    const pool = personIds.filter(id => !unavail.has(id) && id !== pres.presenterId);
    const newQ = chooseQuestioners(
      pres.presenterId,
      pool,
      config.questionersPerPresenter,
      state,
      sqc,
      ctx,
      guidance,
    );
    pres.questionerIds = newQ;

    for (const q of newQ) {
      const questionerInc =
        frequencyRoleFactor(q, 'questioner', guidance)
        * affinityPairFactor(pres.presenterId, q, guidance);
      incrementCount(state.questionerCounts, q, questionerInc);
      incrementCount(state.totalRoleCounts, q, questionerInc);
      incrementCount(state.pairCounts, `${q}→${pres.presenterId}`);
      incrementCount(sqc, q);
    }
  }
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
  const state = buildAssignmentState(personIds, historicalSessions, guidance);

  for (let si = 0; si < dates.length; si++) {
    const date = dates[si];
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const available = personIds.filter(id => !unavail.has(id));
    const n = Math.min(maxPresenters, available.length);
    if (n === 0) { sessions.push({ date, presentations: [] }); continue; }

    const presenters = choosePresenters(available, n, state, guidance);
    const sqc = new Map<string, number>();
    const presentations: Presentation[] = [];

    for (const presenterId of presenters) {
      const presenterInc = frequencyRoleFactor(presenterId, 'presenter', guidance);
      incrementCount(state.presenterCounts, presenterId, presenterInc);
      incrementCount(state.totalRoleCounts, presenterId, presenterInc);
      state.lastPresentationIndex.set(presenterId, historicalSessions.length + si);

      const questionerIds = chooseQuestioners(
        presenterId,
        available,
        config.questionersPerPresenter,
        state,
        sqc,
        ctx,
        guidance,
      );
      for (const q of questionerIds) {
        const questionerInc =
          frequencyRoleFactor(q, 'questioner', guidance)
          * affinityPairFactor(presenterId, q, guidance);
        incrementCount(state.questionerCounts, q, questionerInc);
        incrementCount(state.totalRoleCounts, q, questionerInc);
        incrementCount(state.pairCounts, `${q}→${presenterId}`);
        incrementCount(sqc, q);
      }
      presentations.push({ presenterId, questionerIds });
    }
    sessions.push({ date, presentations });
  }
  return sessions;
}

// #endregion

// #region Mutation strategies (all mutate sessions in-place on a pre-cloned array)

function swapPresentersMutation(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
): void {
  const i = Math.floor(Math.random() * sessions.length);
  const j = Math.floor(Math.random() * sessions.length);
  const si = sessions[i];
  const sj = sessions[j];
  if (!si.presentations.length || !sj.presentations.length) return;

  const pi = Math.floor(Math.random() * si.presentations.length);
  const pj = Math.floor(Math.random() * sj.presentations.length);
  const candA = sj.presentations[pj].presenterId; // enters session i
  const candB = si.presentations[pi].presenterId; // enters session j

  const unavailI = unavailMap.get(si.date) ?? new Set<string>();
  const unavailJ = unavailMap.get(sj.date) ?? new Set<string>();
  if (unavailI.has(candA) || unavailJ.has(candB)) return;
  if (si.presentations.some((p, k) => k !== pi && p.presenterId === candA)) return;
  if (sj.presentations.some((p, k) => k !== pj && p.presenterId === candB)) return;

  si.presentations[pi].presenterId = candA;
  sj.presentations[pj].presenterId = candB;
  repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
    { sessionIndex: i, presentationIndex: pi },
    { sessionIndex: j, presentationIndex: pj },
  ]);
}

function reassignQuestionersMutation(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
): void {
  const si = Math.floor(Math.random() * sessions.length);
  if (!sessions[si].presentations.length) return;
  const pi = Math.floor(Math.random() * sessions[si].presentations.length);
  repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
    { sessionIndex: si, presentationIndex: pi },
  ]);
}

function replacePresenterMutation(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
): void {
  // Build global presenter counts so we can favour under-represented people.
  const counts = new Map<string, number>(personIds.map(id => [id, 0]));
  for (const s of [...historicalSessions, ...sessions]) {
    for (const p of s.presentations) incrementCount(counts, p.presenterId);
  }

  const si = Math.floor(Math.random() * sessions.length);
  const sess = sessions[si];
  if (!sess.presentations.length) return;
  const pi = Math.floor(Math.random() * sess.presentations.length);

  const unavail = unavailMap.get(sess.date) ?? new Set<string>();
  const occupied = new Set(sess.presentations.map(p => p.presenterId));
  const candidates = personIds
    .filter(id => !unavail.has(id) && !occupied.has(id))
    .sort((a, b) => {
      const d = (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
      return d !== 0 ? d : Math.random() - 0.5;
    });
  if (!candidates.length) return;

  sess.presentations[pi].presenterId = candidates[0];
  repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
    { sessionIndex: si, presentationIndex: pi },
  ]);
}

/**
 * Identify the person with the largest absolute frequency-multiplier deviation
 * and directly insert or remove them from a presenter or questioner slot.
 * Falls back to replacePresenterMutation when no such constraints are active.
 */
function frequencyTargetedMutation(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
): void {
  const guidance = buildConstraintGuidance(ctx);
  if (!guidance.frequency.length) {
    replacePresenterMutation(sessions, personIds, ctx, historicalSessions, config, unavailMap);
    return;
  }

  // Build current counts across historical + planned sessions.
  const state = buildAssignmentState(personIds, historicalSessions, guidance, sessions);
  const presenterCounts = state.presenterCounts;
  const questionerCounts = state.questionerCounts;

  // Find the person with the largest absolute deviation from their target.
  let maxAbsDev = -1;
  let targetId: string | null = null;
  let needsMore = true;
  let roleScope: 'presenter' | 'questioner' | 'both' = 'presenter';

  for (const c of guidance.frequency) {
    for (const id of c.personIds) {
      const pc = presenterCounts.get(id) ?? 0;
      const qc = questionerCounts.get(id) ?? 0;
      const actual = c.roleScope === 'both' ? pc + qc : c.roleScope === 'questioner' ? qc : pc;
      const dev = c.baseline - actual;
      if (Math.abs(dev) > maxAbsDev) {
        maxAbsDev = Math.abs(dev);
        targetId = id;
        needsMore = dev > 0;
        roleScope = c.roleScope;
      }
    }
  }

  if (!targetId || maxAbsDev === 0) {
    replacePresenterMutation(sessions, personIds, ctx, historicalSessions, config, unavailMap);
    return;
  }

  const affectsPresenter = roleScope === 'presenter' || roleScope === 'both';
  const affectsQuestioner = roleScope === 'questioner' || roleScope === 'both';

  // --- Needs more appearances as presenter ---
  if (needsMore && affectsPresenter) {
    const candidates = sessions
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => {
        const unavail = unavailMap.get(s.date) ?? new Set();
        return (
          !unavail.has(targetId!) &&
          s.presentations.length > 0 &&
          !s.presentations.some(p => p.presenterId === targetId)
        );
      });
    if (!candidates.length) return;
    const { s, idx } = candidates[Math.floor(Math.random() * candidates.length)];
    // Evict the most over-represented presenter in that session.
    const overRepIdx = s.presentations
      .map((p, pi) => ({ pi, count: presenterCounts.get(p.presenterId) ?? 0 }))
      .sort((a, b) => b.count - a.count)[0].pi;
    sessions[idx].presentations[overRepIdx].presenterId = targetId;
    repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
      { sessionIndex: idx, presentationIndex: overRepIdx },
    ]);
    return;
  }

  // --- Has too many presenter appearances ---
  if (!needsMore && affectsPresenter) {
    const slots = sessions.flatMap((s, si) =>
      s.presentations.flatMap((p, pi) => (p.presenterId === targetId ? [{ si, pi }] : [])),
    );
    if (!slots.length) return;
    const { si, pi } = slots[Math.floor(Math.random() * slots.length)];
    const sess = sessions[si];
    const unavail = unavailMap.get(sess.date) ?? new Set<string>();
    const occupied = new Set(sess.presentations.map(p => p.presenterId));
    const replacement = personIds
      .filter(id => id !== targetId && !unavail.has(id) && !occupied.has(id))
      .sort((a, b) => (presenterCounts.get(a) ?? 0) - (presenterCounts.get(b) ?? 0))[0];
    if (!replacement) return;
    sessions[si].presentations[pi].presenterId = replacement;
    repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
      { sessionIndex: si, presentationIndex: pi },
    ]);
    return;
  }

  // --- Questioner-only scope: reassign a presentation to adjust questioner balance ---
  if (affectsQuestioner) {
    if (needsMore) {
      // Pick a session where the person is available; questioner repair will favour them
      // because they currently have a low questionerCount.
      const candidates = sessions
        .map((s, idx) => ({ s, idx }))
        .filter(({ s }) => {
          const unavail = unavailMap.get(s.date) ?? new Set();
          return !unavail.has(targetId!) && s.presentations.length > 0;
        });
      if (!candidates.length) return;
      const { idx } = candidates[Math.floor(Math.random() * candidates.length)];
      const pi = Math.floor(Math.random() * sessions[idx].presentations.length);
      repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
        { sessionIndex: idx, presentationIndex: pi },
      ]);
    } else {
      // Find a presentation where targetId is currently a questioner and reassign it.
      const slots = sessions.flatMap((s, si) =>
        s.presentations.flatMap((p, pi) =>
          p.questionerIds.includes(targetId!) ? [{ si, pi }] : [],
        ),
      );
      if (!slots.length) return;
      const { si, pi } = slots[Math.floor(Math.random() * slots.length)];
      repairQuestionersForTargets(sessions, personIds, ctx, historicalSessions, config, unavailMap, [
        { sessionIndex: si, presentationIndex: pi },
      ]);
    }
  }
}

/**
 * Completely rebuild all presenter and questioner assignments for one random session.
 * This provides large neighborhood jumps to escape deep local optima.
 */
function sessionRebuildMutation(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>>,
): void {
  if (!sessions.length) return;
  const si = Math.floor(Math.random() * sessions.length);
  const sess = sessions[si];
  if (!sess.presentations.length) return;

  const unavail = unavailMap.get(sess.date) ?? new Set<string>();
  const available = personIds.filter(id => !unavail.has(id));
  // Require enough unique people to fill every slot; otherwise skip.
  if (available.length < sess.presentations.length) return;

  const targets = sess.presentations.map((_, pi) => ({ sessionIndex: si, presentationIndex: pi }));
  const guidance = buildConstraintGuidance(ctx);
  const state = buildAssignmentState(
    personIds, historicalSessions, guidance, sessions,
    new Set(targets.map(t => `${t.sessionIndex}:${t.presentationIndex}`)),
  );

  const newPresenters = choosePresenters(available, sess.presentations.length, state, guidance);
  const sqc = new Map<string, number>();

  newPresenters.forEach((presenterId, pi) => {
    sess.presentations[pi].presenterId = presenterId;
    const presenterInc = frequencyRoleFactor(presenterId, 'presenter', guidance);
    incrementCount(state.presenterCounts, presenterId, presenterInc);
    incrementCount(state.totalRoleCounts, presenterId, presenterInc);
    state.lastPresentationIndex.set(presenterId, historicalSessions.length + si);

    const questionerIds = chooseQuestioners(
      presenterId,
      available,
      config.questionersPerPresenter,
      state,
      sqc,
      ctx,
      guidance,
    );
    sess.presentations[pi].questionerIds = questionerIds;

    for (const q of questionerIds) {
      const questionerInc =
        frequencyRoleFactor(q, 'questioner', guidance)
        * affinityPairFactor(presenterId, q, guidance);
      incrementCount(state.questionerCounts, q, questionerInc);
      incrementCount(state.totalRoleCounts, q, questionerInc);
      incrementCount(state.pairCounts, `${q}→${presenterId}`);
      incrementCount(sqc, q);
    }
  });
}

// ---------------------------------------------------------------------------
// Unified mutate
// ---------------------------------------------------------------------------

function pickStrategy(): keyof typeof MUTATION_WEIGHTS {
  const entries = Object.entries(MUTATION_WEIGHTS) as [keyof typeof MUTATION_WEIGHTS, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [key, weight] of entries) {
    r -= weight;
    if (r <= 0) return key;
  }
  return 'reassignQuestioners';
}

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

  switch (pickStrategy()) {
    case 'swapPresenters':
      swapPresentersMutation(clone, personIds, ctx, historicalSessions, config, unavailMap);
      break;
    case 'reassignQuestioners':
      reassignQuestionersMutation(clone, personIds, ctx, historicalSessions, config, unavailMap);
      break;
    case 'replacePresenter':
      replacePresenterMutation(clone, personIds, ctx, historicalSessions, config, unavailMap);
      break;
    case 'frequencyTargeted':
      frequencyTargetedMutation(clone, personIds, ctx, historicalSessions, config, unavailMap);
      break;
    case 'sessionRebuild':
      sessionRebuildMutation(clone, personIds, ctx, historicalSessions, config, unavailMap);
      break;
  }

  return clone;
}

// ---------------------------------------------------------------------------
// Simulated annealing
// ---------------------------------------------------------------------------

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
    const optimized = simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap);
  
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
  },
}