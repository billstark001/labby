/**
 * Scheduling solver using local search + simulated annealing.
 *
 * Cost function components:
 *   1. Uniformity penalty   – variance of each person's presentation intervals
 *   2. Questioner focus     – exponential penalty when one person questions another >1×
 *   3. Domain relevance     – |similarity(questioner, presenter) - r| summed over all pairs
 *
 * The incremental solver adds a Hamming penalty to minimise churn vs the old plan.
 */

import type {
  MetricExplanation,
  SchedulePlan,
  ScheduleMetrics,
  Session,
  Presentation,
  SolverInput,
  IncrementalSolverInput,
  ScheduleConfig,
  PersonUnavailability,
  SimilarityLookup,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup: date → Set of unavailable personIds.
 * Only includes unavailabilities for the given configId.
 */
function buildUnavailMap(
  unavailabilities: PersonUnavailability[],
  configId: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const u of unavailabilities) {
    if (u.configId !== configId) continue;
    // Use UTC to avoid local-timezone date skew – dates are stored as YYYY-MM-DD strings
    const [sy, sm, sd] = u.startDate.split('-').map(Number);
    const [ey, em, ed] = u.endDate.split('-').map(Number);
    const start = Date.UTC(sy, sm - 1, sd);
    const end = Date.UTC(ey, em - 1, ed);
    for (let t = start; t <= end; t += 86400_000) {
      const d = new Date(t);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      if (!map.has(dateStr)) map.set(dateStr, new Set());
      map.get(dateStr)!.add(u.personId);
    }
  }
  return map;
}

/** Generate a UUID-like string (not cryptographically strong, sufficient for IDs). */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Get the ISO date string for a given Date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Return all ISO dates between start and end (inclusive) that match daysOfWeek. */
export function generateSessionDates(config: ScheduleConfig): string[] {
  const dates: string[] = [];
  const end = new Date(config.endDate + 'T00:00:00Z');
  const cur = new Date(config.startDate + 'T00:00:00Z');
  while (cur <= end) {
    // getUTCDay() returns 0=Sun..6=Sat
    if (config.daysOfWeek.includes(cur.getUTCDay())) {
      dates.push(isoDate(cur));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Look up similarity between two persons based on their keyword sets. */
function personSimilarity(
  aKeywords: string[],
  bKeywords: string[],
  sim: Map<string, number> | SimilarityLookup,
): number {
  if (aKeywords.length === 0 || bKeywords.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const a of aKeywords) {
    for (const b of bKeywords) {
      if (a === b) {
        total += 1;
        count++;
        continue;
      }
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const w = sim instanceof Map
        ? sim.get(key)
        : sim.getPairSimilarity(a, b);
      if (w !== undefined) {
        total += w;
        count++;
      }
    }
  }
  return count === 0 ? 0 : total / count;
}

// ---------------------------------------------------------------------------
// Cost function
// ---------------------------------------------------------------------------

interface CostContext {
  personKeywords: Map<string, string[]>;
  similarities: Map<string, number> | SimilarityLookup;
  r: number; // target similarity radius
  constraints?: import('./types.js').ScheduleConstraint[];
}

interface CostBreakdown {
  uniformityPenalty: number;
  questionerPenalty: number;
  relevancePenalty: number;
  presenterLoadPenalty: number;
  questionerLoadPenalty: number;
  totalRolePenalty: number;
  invalidAssignmentPenalty: number;
  constraintPenalty: number;
}

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

function incrementCount(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function varianceForPeople(counts: Map<string, number>, personIds: string[]): number {
  if (personIds.length === 0) return 0;
  const values = personIds.map(id => counts.get(id) ?? 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function buildAssignmentState(
  personIds: string[],
  historicalSessions: Session[],
  currentSessions: Session[] = [],
  excludedTargets = new Set<string>(),
): AssignmentState {
  const presenterCounts = new Map<string, number>();
  const questionerCounts = new Map<string, number>();
  const totalRoleCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const lastPresentationIndex = new Map<string, number>();

  for (const personId of personIds) {
    presenterCounts.set(personId, 0);
    questionerCounts.set(personId, 0);
    totalRoleCounts.set(personId, 0);
  }

  const registerPresentation = (
    presentation: Presentation,
    absoluteIndex: number,
    includeQuestioners = true,
  ) => {
    incrementCount(presenterCounts, presentation.presenterId);
    incrementCount(totalRoleCounts, presentation.presenterId);
    lastPresentationIndex.set(presentation.presenterId, absoluteIndex);

    if (!includeQuestioners) return;

    for (const questionerId of presentation.questionerIds) {
      incrementCount(questionerCounts, questionerId);
      incrementCount(totalRoleCounts, questionerId);
      incrementCount(pairCounts, `${questionerId}→${presentation.presenterId}`);
    }
  };

  historicalSessions.forEach((session, sessionIndex) => {
    for (const presentation of session.presentations) {
      registerPresentation(presentation, sessionIndex, true);
    }
  });

  const baseIndex = historicalSessions.length;
  currentSessions.forEach((session, sessionIndex) => {
    session.presentations.forEach((presentation, presentationIndex) => {
      const includeQuestioners = !excludedTargets.has(`${sessionIndex}:${presentationIndex}`);
      registerPresentation(presentation, baseIndex + sessionIndex, includeQuestioners);
    });
  });

  return {
    presenterCounts,
    questionerCounts,
    totalRoleCounts,
    pairCounts,
    lastPresentationIndex,
  };
}

function choosePresenters(
  availableIds: string[],
  count: number,
  state: AssignmentState,
): string[] {
  return availableIds
    .map(id => ({ id, tieBreaker: Math.random() }))
    .sort((left, right) => {
      const presenterDiff = (state.presenterCounts.get(left.id) ?? 0) - (state.presenterCounts.get(right.id) ?? 0);
      if (presenterDiff !== 0) return presenterDiff;

      const totalRoleDiff = (state.totalRoleCounts.get(left.id) ?? 0) - (state.totalRoleCounts.get(right.id) ?? 0);
      if (totalRoleDiff !== 0) return totalRoleDiff;

      const leftLast = state.lastPresentationIndex.get(left.id) ?? -1;
      const rightLast = state.lastPresentationIndex.get(right.id) ?? -1;
      if (leftLast !== rightLast) return leftLast - rightLast;

      return left.tieBreaker - right.tieBreaker;
    })
    .slice(0, count)
    .map(entry => entry.id);
}

function chooseQuestioners(
  presenterId: string,
  availableIds: string[],
  desiredCount: number,
  state: AssignmentState,
  sessionQuestionerCounts: Map<string, number>,
  ctx: CostContext,
): string[] {
  const presenterKeywords = ctx.personKeywords.get(presenterId) ?? [];

  return availableIds
    .filter(id => id !== presenterId)
    .map(id => ({ id, tieBreaker: Math.random() }))
    .sort((left, right) => {
      const questionerDiff = (state.questionerCounts.get(left.id) ?? 0) - (state.questionerCounts.get(right.id) ?? 0);
      if (questionerDiff !== 0) return questionerDiff;

      const totalRoleDiff = (state.totalRoleCounts.get(left.id) ?? 0) - (state.totalRoleCounts.get(right.id) ?? 0);
      if (totalRoleDiff !== 0) return totalRoleDiff;

      const sessionDiff = (sessionQuestionerCounts.get(left.id) ?? 0) - (sessionQuestionerCounts.get(right.id) ?? 0);
      if (sessionDiff !== 0) return sessionDiff;

      const pairDiff = (state.pairCounts.get(`${left.id}→${presenterId}`) ?? 0) - (state.pairCounts.get(`${right.id}→${presenterId}`) ?? 0);
      if (pairDiff !== 0) return pairDiff;

      const leftSimilarity = personSimilarity(
        presenterKeywords,
        ctx.personKeywords.get(left.id) ?? [],
        ctx.similarities,
      );
      const rightSimilarity = personSimilarity(
        presenterKeywords,
        ctx.personKeywords.get(right.id) ?? [],
        ctx.similarities,
      );
      const relevanceDiff = Math.abs(leftSimilarity - ctx.r) - Math.abs(rightSimilarity - ctx.r);
      if (relevanceDiff !== 0) return relevanceDiff;

      return left.tieBreaker - right.tieBreaker;
    })
    .slice(0, desiredCount)
    .map(entry => entry.id);
}

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

  const excludedTargets = new Set(targets.map(target => `${target.sessionIndex}:${target.presentationIndex}`));
  const state = buildAssignmentState(personIds, historicalSessions, sessions, excludedTargets);

  for (const target of targets) {
    const session = sessions[target.sessionIndex];
    const presentation = session?.presentations[target.presentationIndex];
    if (!session || !presentation) continue;

    const sessionQuestionerCounts = new Map<string, number>();
    session.presentations.forEach((otherPresentation, otherIndex) => {
      if (otherIndex === target.presentationIndex) return;
      for (const questionerId of otherPresentation.questionerIds) {
        incrementCount(sessionQuestionerCounts, questionerId);
      }
    });

    const unavail = unavailMap.get(session.date) ?? new Set<string>();
    const pool = personIds.filter(id => !unavail.has(id) && id !== presentation.presenterId);
    const nextQuestioners = chooseQuestioners(
      presentation.presenterId,
      pool,
      config.questionersPerPresenter,
      state,
      sessionQuestionerCounts,
      ctx,
    );

    presentation.questionerIds = nextQuestioners;

    for (const questionerId of nextQuestioners) {
      incrementCount(state.questionerCounts, questionerId);
      incrementCount(state.totalRoleCounts, questionerId);
      incrementCount(state.pairCounts, `${questionerId}→${presentation.presenterId}`);
      incrementCount(sessionQuestionerCounts, questionerId);
    }
  }
}

function computeCostBreakdown(
  sessions: Session[],
  ctx: CostContext,
  historicalSessions: Session[] = [],
): CostBreakdown {
  const allSessions = [...historicalSessions, ...sessions];
  const personIds = [...ctx.personKeywords.keys()];

  // Track presentation indices per person
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

  // 1. Uniformity penalty – variance of presentation gaps
  let uniformityPenalty = 0;
  for (const indices of presentationIndices.values()) {
    if (indices.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < indices.length; i++) {
      gaps.push(indices[i] - indices[i - 1]);
    }
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    uniformityPenalty += variance;
  }

  // 2. Questioner focus penalty – exponential when one person questions another >1×
  const questionerFreq = new Map<string, number>();
  let questionerPenalty = 0;
  let invalidAssignmentPenalty = 0;
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      const seenQuestioners = new Set<string>();
      for (const q of pres.questionerIds) {
        incrementCount(questionerCounts, q);
        incrementCount(totalRoleCounts, q);

        if (q === pres.presenterId) {
          invalidAssignmentPenalty += 1000;
        }
        if (seenQuestioners.has(q)) {
          invalidAssignmentPenalty += 250;
        }
        seenQuestioners.add(q);

        const key = `${q}→${pres.presenterId}`;
        const freq = (questionerFreq.get(key) ?? 0) + 1;
        questionerFreq.set(key, freq);
        if (freq > 1) {
          questionerPenalty += Math.exp(freq - 1) - 1;
        }
      }
    }
  }

  // 3. Domain relevance penalty – |sim(questioner, presenter) - r|
  let relevancePenalty = 0;
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      const pk = ctx.personKeywords.get(pres.presenterId) ?? [];
      for (const q of pres.questionerIds) {
        const qk = ctx.personKeywords.get(q) ?? [];
        const s = personSimilarity(pk, qk, ctx.similarities);
        relevancePenalty += Math.abs(s - ctx.r);
      }
    }
  }

  const presenterLoadPenalty = varianceForPeople(presenterCounts, personIds);
  const questionerLoadPenalty = varianceForPeople(questionerCounts, personIds);
  const totalRolePenalty = varianceForPeople(totalRoleCounts, personIds);

  // 4. Constraint penalties
  let constraintPenalty = 0;
  if (ctx.constraints) {
    for (const constraint of ctx.constraints) {
      if (constraint.type === 'no-overlap') {
        const groupSet = new Set(constraint.personIds);
        const penaltyWeight = constraint.weight ?? 5.0;
        for (const sess of allSessions) {
          for (const pres of sess.presentations) {
            if (!groupSet.has(pres.presenterId)) continue;
            for (const q of pres.questionerIds) {
              if (groupSet.has(q)) {
                constraintPenalty += penaltyWeight;
              }
            }
          }
        }
      } else if (constraint.type === 'affinity-boost') {
        const groupSet = new Set(constraint.personIds);
        const boost = constraint.boost ?? 2.0;
        // Reward co-occurrence: subtract from penalty when group members are paired
        for (const sess of allSessions) {
          for (const pres of sess.presentations) {
            const presenterInGroup = groupSet.has(pres.presenterId);
            for (const q of pres.questionerIds) {
              const questionerInGroup = groupSet.has(q);
              if (presenterInGroup && questionerInGroup) {
                constraintPenalty -= (boost - 1) * 0.5;
              }
            }
          }
        }
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

function weightedTotalCost(breakdown: CostBreakdown): number {
  return (
    breakdown.uniformityPenalty * 2
    + breakdown.questionerPenalty * 5
    + breakdown.relevancePenalty
    + breakdown.presenterLoadPenalty * 12
    + breakdown.questionerLoadPenalty * 10
    + breakdown.totalRolePenalty * 4
    + breakdown.invalidAssignmentPenalty
    + breakdown.constraintPenalty
  );
}

function toScheduleMetrics(breakdown: CostBreakdown): ScheduleMetrics {
  return {
    ...breakdown,
    totalCost: weightedTotalCost(breakdown),
  };
}

function buildCostContext(input: SolverInput): CostContext {
  const activePeople = input.persons.filter(p => !p.disabled);
  const personKeywords = new Map(activePeople.map(p => [p.id, p.keywordIds]));
  return {
    personKeywords,
    similarities: input.similarities,
    r: input.config.targetSimilarityRadius,
    constraints: input.constraints ?? [],
  };
}

function metricSummary(key: keyof ScheduleMetrics, value: number): string {
  if (key === 'totalCost') return `Overall objective value: ${value.toFixed(3)} (lower is better).`;
  if (key === 'uniformityPenalty') return `Presentation interval variance is ${value.toFixed(3)}.`;
  if (key === 'questionerPenalty') return `Repeated questioner-presenter pairs contribute ${value.toFixed(3)}.`;
  if (key === 'relevancePenalty') return `Similarity mismatch contributes ${value.toFixed(3)}.`;
  if (key === 'presenterLoadPenalty') return `Presenter load imbalance variance is ${value.toFixed(3)}.`;
  if (key === 'questionerLoadPenalty') return `Questioner load imbalance variance is ${value.toFixed(3)}.`;
  if (key === 'totalRolePenalty') return `Overall role imbalance variance is ${value.toFixed(3)}.`;
  if (key === 'invalidAssignmentPenalty') return `Hard assignment violations contribute ${value.toFixed(3)}.`;
  return `Constraint effects contribute ${value.toFixed(3)}.`;
}

export function explainScheduleMetrics(metrics: ScheduleMetrics): MetricExplanation[] {
  const orderedKeys: Array<keyof ScheduleMetrics> = [
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
  return orderedKeys.map((key) => ({
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
  const breakdown = computeCostBreakdown(plan.sessions, ctx, historicalSessions);
  return toScheduleMetrics(breakdown);
}

function computeCost(
  sessions: Session[],
  ctx: CostContext,
  historicalSessions: Session[] = [],
): number {
  return weightedTotalCost(computeCostBreakdown(sessions, ctx, historicalSessions));
}

// ---------------------------------------------------------------------------
// Schedule builder
// ---------------------------------------------------------------------------

/**
 * Build a random valid schedule: assign presenters round-robin (no duplicate
 * presenter within the same session) and randomly pick questioners.
 *
 * If there are fewer people than presentersPerSession, the number of
 * presentations per session is capped at the person count, ensuring no one
 * presents twice on the same day.  If personIds is empty the sessions are
 * returned with empty presentations.
 */
function buildRandomSchedule(
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

  // Cap to avoid forcing the same person to present twice in one session.
  const numPresenters = Math.min(config.presentersPerSession, personIds.length);
  const sessions: Session[] = [];
  const state = buildAssignmentState(personIds, historicalSessions);

  for (let sessionIndex = 0; sessionIndex < dates.length; sessionIndex++) {
    const date = dates[sessionIndex];
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const availableIds = personIds.filter(id => !unavail.has(id));
    const numPres = Math.min(numPresenters, availableIds.length);

    if (numPres === 0) {
      sessions.push({ date, presentations: [] });
      continue;
    }

    const sessionPresenters = choosePresenters(availableIds, numPres, state);
    const sessionQuestionerCounts = new Map<string, number>();
    const presentations: Presentation[] = [];

    for (const presenterId of sessionPresenters) {
      incrementCount(state.presenterCounts, presenterId);
      incrementCount(state.totalRoleCounts, presenterId);
      state.lastPresentationIndex.set(presenterId, historicalSessions.length + sessionIndex);

      const questionerIds = chooseQuestioners(
        presenterId,
        availableIds,
        config.questionersPerPresenter,
        state,
        sessionQuestionerCounts,
        ctx,
      );

      for (const questionerId of questionerIds) {
        incrementCount(state.questionerCounts, questionerId);
        incrementCount(state.totalRoleCounts, questionerId);
        incrementCount(state.pairCounts, `${questionerId}→${presenterId}`);
        incrementCount(sessionQuestionerCounts, questionerId);
      }

      presentations.push({ presenterId, questionerIds });
    }

    sessions.push({ date, presentations });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Simulated annealing
// ---------------------------------------------------------------------------

function simulatedAnnealing(
  initial: Session[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  hammingRef: Session[] | null,
  hammingWeight: number,
  unavailMap: Map<string, Set<string>> = new Map(),
  maxIter = 5000,
): Session[] {
  let current = deepCloneSessions(initial);
  let currentCost = computeCost(current, ctx, historicalSessions);
  if (hammingRef) currentCost += hammingWeight * hammingDistance(current, hammingRef);

  let best = deepCloneSessions(current);
  let bestCost = currentCost;

  const personIds = ctx.personKeywords
    ? [...ctx.personKeywords.keys()]
    : [];

  for (let iter = 0; iter < maxIter; iter++) {
    const temperature = 1.0 * Math.pow(0.995, iter);
    const neighbor = mutate(current, personIds, ctx, historicalSessions, config, unavailMap);
    let neighborCost = computeCost(neighbor, ctx, historicalSessions);
    if (hammingRef) neighborCost += hammingWeight * hammingDistance(neighbor, hammingRef);

    const delta = neighborCost - currentCost;
    if (delta < 0 || Math.random() < Math.exp(-delta / temperature)) {
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

/**
 * Mutate a schedule: randomly either swap two presenters across sessions
 * or reassign a questioner in a random presentation.
 */
function mutate(
  sessions: Session[],
  personIds: string[],
  ctx: CostContext,
  historicalSessions: Session[],
  config: ScheduleConfig,
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  const clone = deepCloneSessions(sessions);
  if (clone.length === 0) return clone;

  if (Math.random() < 0.5) {
    // Swap two presenters across two random sessions if both are available
    const i = Math.floor(Math.random() * clone.length);
    const j = Math.floor(Math.random() * clone.length);
    const si = clone[i];
    const sj = clone[j];
    if (si.presentations.length === 0 || sj.presentations.length === 0) return clone;
    const pi = Math.floor(Math.random() * si.presentations.length);
    const pj = Math.floor(Math.random() * sj.presentations.length);
    const candidateA = sj.presentations[pj].presenterId;
    const candidateB = si.presentations[pi].presenterId;
    const unavailI = unavailMap.get(si.date) ?? new Set<string>();
    const unavailJ = unavailMap.get(sj.date) ?? new Set<string>();
    if (unavailI.has(candidateA) || unavailJ.has(candidateB)) return clone;
    if (si.presentations.some((presentation, index) => index !== pi && presentation.presenterId === candidateA)) return clone;
    if (sj.presentations.some((presentation, index) => index !== pj && presentation.presenterId === candidateB)) return clone;
    si.presentations[pi].presenterId = candidateA;
    sj.presentations[pj].presenterId = candidateB;
    repairQuestionersForTargets(
      clone,
      personIds,
      ctx,
      historicalSessions,
      config,
      unavailMap,
      [
        { sessionIndex: i, presentationIndex: pi },
        { sessionIndex: j, presentationIndex: pj },
      ],
    );
  } else {
    // Reassign questioners for a random presentation
    const si = Math.floor(Math.random() * clone.length);
    const sess = clone[si];
    if (sess.presentations.length === 0) return clone;
    const pi = Math.floor(Math.random() * sess.presentations.length);
    repairQuestionersForTargets(
      clone,
      personIds,
      ctx,
      historicalSessions,
      config,
      unavailMap,
      [{ sessionIndex: si, presentationIndex: pi }],
    );
  }
  return clone;
}

function deepCloneSessions(sessions: Session[]): Session[] {
  return sessions.map(s => ({
    date: s.date,
    presentations: s.presentations.map(p => ({
      presenterId: p.presenterId,
      questionerIds: [...p.questionerIds],
    })),
  }));
}

/** Count the number of (date, presenter) pairs that differ between two plans. */
function hammingDistance(a: Session[], b: Session[]): number {
  const mapB = new Map<string, Set<string>>();
  for (const s of b) {
    mapB.set(s.date, new Set(s.presentations.map(p => p.presenterId)));
  }
  let diff = 0;
  for (const s of a) {
    const bPresenters = mapB.get(s.date);
    if (!bPresenters) {
      diff += s.presentations.length;
      continue;
    }
    for (const p of s.presentations) {
      if (!bPresenters.has(p.presenterId)) diff++;
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full solver: generate a schedule from scratch.
 */
export function solveFull(input: SolverInput): SchedulePlan {
  const { persons, similarities, config, unavailabilities = [], constraints = [] } = input;
  const activePeople = persons.filter(p => !p.disabled);
  const personIds = activePeople.map(p => p.id);
  const personKeywords = new Map(activePeople.map(p => [p.id, p.keywordIds]));
  const ctx: CostContext = { personKeywords, similarities, r: config.targetSimilarityRadius, constraints };

  const dates = generateSessionDates(config);
  const unavailMap = buildUnavailMap(unavailabilities, config.id);
  const initial = buildRandomSchedule(personIds, dates, config, ctx, [], unavailMap);
  const optimised = simulatedAnnealing(initial, ctx, [], config, null, 0, unavailMap);

  return {
    id: generateId(),
    createdAt: Date.now(),
    configId: config.id,
    sessions: optimised,
  };
}

/**
 * Incremental solver: re-schedule only sessions from changeDate onward,
 * minimising divergence from the previous plan.
 */
export function solveIncremental(input: IncrementalSolverInput): SchedulePlan {
  const { persons, similarities, config, previousPlan, changeDate, unavailabilities = [], constraints = [] } = input;

  const frozenSessions = previousPlan.sessions.filter(s => s.date < changeDate);
  const mutableDates = previousPlan.sessions
    .filter(s => s.date >= changeDate)
    .map(s => s.date);

  const activePeople = persons.filter(p => !p.disabled);
  const personIds = activePeople.map(p => p.id);
  const personKeywords = new Map(activePeople.map(p => [p.id, p.keywordIds]));
  const ctx: CostContext = { personKeywords, similarities, r: config.targetSimilarityRadius, constraints };

  // Reference sessions from previous plan for Hamming penalty
  const hammingRef = previousPlan.sessions.filter(s => s.date >= changeDate);
  const unavailMap = buildUnavailMap(unavailabilities, config.id);

  const initial = buildRandomSchedule(personIds, mutableDates, config, ctx, frozenSessions, unavailMap);
  const optimised = simulatedAnnealing(
    initial,
    ctx,
    frozenSessions,
    config,
    hammingRef,
    10, // increased Hamming weight for minimal churn
    unavailMap,
  );

  return {
    id: generateId(),
    createdAt: Date.now(),
    configId: config.id,
    sessions: [...frozenSessions, ...optimised],
  };
}
