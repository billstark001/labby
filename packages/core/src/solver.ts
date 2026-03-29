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
  SchedulePlan,
  Session,
  Presentation,
  SolverInput,
  IncrementalSolverInput,
  ScheduleConfig,
  PersonUnavailability,
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
    const start = new Date(u.startDate + 'T00:00:00Z');
    const end = new Date(u.endDate + 'T00:00:00Z');
    const cur = new Date(start);
    while (cur <= end) {
      const dateStr = cur.toISOString().slice(0, 10);
      if (!map.has(dateStr)) map.set(dateStr, new Set());
      map.get(dateStr)!.add(u.personId);
      cur.setUTCDate(cur.getUTCDate() + 1);
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
  sim: Map<string, number>,
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
      const w = sim.get(key);
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
  similarities: Map<string, number>;
  r: number; // target similarity radius
}

function computeCost(
  sessions: Session[],
  ctx: CostContext,
  historicalSessions: Session[] = [],
): number {
  const allSessions = [...historicalSessions, ...sessions];

  // Track presentation indices per person
  const presentationIndices = new Map<string, number[]>();
  allSessions.forEach((sess, idx) => {
    for (const p of sess.presentations) {
      const arr = presentationIndices.get(p.presenterId) ?? [];
      arr.push(idx);
      presentationIndices.set(p.presenterId, arr);
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
  for (const sess of allSessions) {
    for (const pres of sess.presentations) {
      for (const q of pres.questionerIds) {
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

  return uniformityPenalty * 2 + questionerPenalty * 5 + relevancePenalty;
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
  unavailMap: Map<string, Set<string>> = new Map(),
): Session[] {
  if (personIds.length === 0) {
    return dates.map(date => ({ date, presentations: [] }));
  }

  const n = personIds.length;
  // Cap to avoid forcing the same person to present twice in one session.
  const numPresenters = Math.min(config.presentersPerSession, n);

  const shuffled = [...personIds].sort(() => Math.random() - 0.5);
  const sessions: Session[] = [];
  let startIdx = 0;

  for (const date of dates) {
    const unavail = unavailMap.get(date) ?? new Set<string>();
    const availableIds = personIds.filter(id => !unavail.has(id));
    const numPres = Math.min(numPresenters, availableIds.length);

    if (numPres === 0) {
      sessions.push({ date, presentations: [] });
      startIdx = (startIdx + numPresenters) % n;
      continue;
    }

    // Build session presenters from available pool in round-robin order
    const sessionPresenters: string[] = [];
    const availSet = new Set(availableIds);
    let attempts = 0;
    while (sessionPresenters.length < numPres && attempts < n * 2) {
      const candidate = shuffled[(startIdx + sessionPresenters.length + attempts) % n];
      if (availSet.has(candidate) && !sessionPresenters.includes(candidate)) {
        sessionPresenters.push(candidate);
      }
      attempts++;
    }
    startIdx = (startIdx + numPresenters) % n;

    const presentations: Presentation[] = sessionPresenters.map(presenter => {
      const pool = availableIds.filter(id => id !== presenter);
      const questionerIds = sampleWithoutReplacement(
        pool,
        config.questionersPerPresenter,
      );
      return { presenterId: presenter, questionerIds };
    });

    sessions.push({ date, presentations });
  }
  return sessions;
}

/** Fisher-Yates sample k items without replacement. */
function sampleWithoutReplacement<T>(arr: T[], k: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < Math.min(k, copy.length); i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    result.push(copy[i]);
  }
  return result;
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
    const neighbor = mutate(current, personIds, config, unavailMap);
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
    si.presentations[pi].presenterId = candidateA;
    sj.presentations[pj].presenterId = candidateB;
  } else {
    // Reassign questioners for a random presentation
    const si = Math.floor(Math.random() * clone.length);
    const sess = clone[si];
    if (sess.presentations.length === 0) return clone;
    const pi = Math.floor(Math.random() * sess.presentations.length);
    const pres = sess.presentations[pi];
    const unavail = unavailMap.get(sess.date) ?? new Set<string>();
    const pool = personIds.filter(id => id !== pres.presenterId && !unavail.has(id));
    pres.questionerIds = sampleWithoutReplacement(pool, config.questionersPerPresenter);
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
  const { persons, similarities, config, unavailabilities = [] } = input;
  const activePeople = persons.filter(p => !p.disabled);
  const personIds = activePeople.map(p => p.id);
  const personKeywords = new Map(activePeople.map(p => [p.id, p.keywordIds]));
  const ctx: CostContext = { personKeywords, similarities, r: config.targetSimilarityRadius };

  const dates = generateSessionDates(config);
  const unavailMap = buildUnavailMap(unavailabilities, config.id);
  const initial = buildRandomSchedule(personIds, dates, config, unavailMap);
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
  const { persons, similarities, config, previousPlan, changeDate, unavailabilities = [] } = input;

  const frozenSessions = previousPlan.sessions.filter(s => s.date < changeDate);
  const mutableDates = previousPlan.sessions
    .filter(s => s.date >= changeDate)
    .map(s => s.date);

  const activePeople = persons.filter(p => !p.disabled);
  const personIds = activePeople.map(p => p.id);
  const personKeywords = new Map(activePeople.map(p => [p.id, p.keywordIds]));
  const ctx: CostContext = { personKeywords, similarities, r: config.targetSimilarityRadius };

  // Reference sessions from previous plan for Hamming penalty
  const hammingRef = previousPlan.sessions.filter(s => s.date >= changeDate);
  const unavailMap = buildUnavailMap(unavailabilities, config.id);

  const initial = buildRandomSchedule(personIds, mutableDates, config, unavailMap);
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
