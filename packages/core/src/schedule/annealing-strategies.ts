/** Annealing moves and search loop. Moves return fresh schedules for deterministic injected randomness. */
import type { Presentation, Session, SolverDiagnostics } from '../types.js';
import { computeCost, validateAssignmentsWithContext, type ConstraintGuidance, type CostContext } from './constraints.js';
import { targetFrequency, targetPresenterGap, targetReciprocal } from './targeted-strategies.js';
import {
  cloneSessions, expectedPresenterCounts, hammingDistance, presenterCounts,
  type RandomSource, type StrategyContext,
} from './strategy-utils.js';

export const MUTATION_WEIGHTS = {
  swapPresenters: 0.20,
  reassignQuestioners: 0.15,
  replacePresenter: 0.15,
  frequencyTargeted: 0.15,
  gapTargeted: 0.10,
  reciprocalTargeted: 0.10,
  sessionRebuild: 0.15,
};

export const ANNEALING_CONFIG = {
  maxIter: 1000,
  maxStagnantIter: 400,
  initialTemp: 1.0,
  coolingRate: 0.995,
  hammingWeight: 10,
};

type Move = (state: StrategyContext) => Session[];

function swapPresenters(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const { unavailable, config, pickQuestioners, random } = state;
  const eligible = clone.filter(session => session.presentations.length > 0);
  if (eligible.length < 2) return clone;
  for (let attempt = 0; attempt < 20; attempt++) {
    const ia = Math.floor(random() * eligible.length);
    let ib = Math.floor(random() * (eligible.length - 1));
    if (ib >= ia) ib++;
    const first = eligible[ia]!;
    const second = eligible[ib]!;
    const pi = Math.floor(random() * first.presentations.length);
    const pj = Math.floor(random() * second.presentations.length);
    const idA = first.presentations[pi]!.presenterId;
    const idB = second.presentations[pj]!.presenterId;
    if (idA === idB || unavailable.get(first.date)?.has(idB) || unavailable.get(second.date)?.has(idA)) continue;
    if (first.presentations.some(presentation => presentation.presenterId === idB)
      || second.presentations.some(presentation => presentation.presenterId === idA)) continue;
    first.presentations[pi]!.presenterId = idB;
    second.presentations[pj]!.presenterId = idA;
    first.presentations[pi]!.questionerIds = pickQuestioners(idB, first.date,
      first.presentations[pi]!.questionerIds.length || config.questionersPerPresenter);
    second.presentations[pj]!.questionerIds = pickQuestioners(idA, second.date,
      second.presentations[pj]!.questionerIds.length || config.questionersPerPresenter);
    break;
  }
  return clone;
}

function reassignQuestioners(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const eligible = clone.filter(session => session.presentations.length > 0);
  if (!eligible.length) return clone;
  const session = eligible[Math.floor(state.random() * eligible.length)]!;
  const presentation = session.presentations[Math.floor(state.random() * session.presentations.length)]!;
  presentation.questionerIds = state.pickQuestioners(presentation.presenterId, session.date,
    presentation.questionerIds.length || state.config.questionersPerPresenter);
  return clone;
}

function replacePresenter(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const eligible = clone.filter(session => session.presentations.length > 0);
  if (!eligible.length) return clone;
  const session = eligible[Math.floor(state.random() * eligible.length)]!;
  const index = Math.floor(state.random() * session.presentations.length);
  const occupied = new Set(session.presentations.map(presentation => presentation.presenterId));
  const counts = presenterCounts([...state.historicalSessions, ...clone], state.personIds);
  const total = state.personIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
  const expected = expectedPresenterCounts(total, state.personIds, state.guidance);
  const candidates = state.personIds.filter(id => !state.unavailable.get(session.date)?.has(id) && !occupied.has(id));
  if (!candidates.length) return clone;
  candidates.sort((a, b) => ((counts.get(a) ?? 0) - (expected.get(a) ?? 0))
    - ((counts.get(b) ?? 0) - (expected.get(b) ?? 0)));
  const pool = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.33)));
  const replacement = pool[Math.floor(state.random() * pool.length)]!;
  const presentation = session.presentations[index]!;
  presentation.presenterId = replacement;
  presentation.questionerIds = state.pickQuestioners(replacement, session.date,
    presentation.questionerIds.length || state.config.questionersPerPresenter);
  return clone;
}

function rebuildSession(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const eligible = clone.filter(session => session.presentations.length > 0);
  if (!eligible.length) return clone;
  const session = eligible[Math.floor(state.random() * eligible.length)]!;
  const counts = presenterCounts([...state.historicalSessions, ...clone], state.personIds);
  for (const presentation of session.presentations)
    counts.set(presentation.presenterId, Math.max(0, (counts.get(presentation.presenterId) ?? 1) - 1));
  const total = state.personIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
  const count = session.presentations.length;
  const expected = expectedPresenterCounts(total + count, state.personIds, state.guidance);
  const candidates = state.personIds.filter(id => !state.unavailable.get(session.date)?.has(id));
  if (candidates.length < count) return clone;
  const picked = new Set<string>();
  const presentations: Presentation[] = [];
  for (let j = 0; j < count; j++) {
    const pool = candidates.filter(id => !picked.has(id));
    if (!pool.length) break;
    const weights = pool.map(id => Math.max(0.01, (expected.get(id) ?? 1) - (counts.get(id) ?? 0)));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let cursor = state.random() * totalWeight;
    let chosen = pool.length - 1;
    for (let index = 0; index < weights.length; index++) {
      cursor -= weights[index]!;
      if (cursor <= 0) { chosen = index; break; }
    }
    const presenterId = pool[chosen]!;
    picked.add(presenterId);
    presentations.push({ presenterId, questionerIds: state.pickQuestioners(presenterId, session.date,
      state.config.questionersPerPresenter) });
  }
  session.presentations = presentations;
  return clone;
}

const MOVES: ReadonlyArray<{ key: keyof typeof MUTATION_WEIGHTS; apply: Move }> = [
  { key: 'swapPresenters', apply: swapPresenters },
  { key: 'reassignQuestioners', apply: reassignQuestioners },
  { key: 'replacePresenter', apply: replacePresenter },
  { key: 'frequencyTargeted', apply: targetFrequency },
  { key: 'gapTargeted', apply: targetPresenterGap },
  { key: 'reciprocalTargeted', apply: targetReciprocal },
  { key: 'sessionRebuild', apply: rebuildSession },
];

export function mutateWithStrategies(state: StrategyContext, weights: Readonly<typeof MUTATION_WEIGHTS>): Session[] {
  if (!state.sessions.length) return state.sessions;
  if (!state.personIds.length) return cloneSessions(state.sessions);
  const total = MOVES.reduce((sum, move) => sum + weights[move.key], 0);
  let cursor = state.random() * total;
  for (const move of MOVES) {
    cursor -= weights[move.key];
    if (cursor <= 0) return move.apply(state);
  }
  return MOVES[0]!.apply(state);
}

export function mutateQuestionersOnly(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const eligible = clone.filter(session => session.presentations.length > 0);
  if (!eligible.length || !state.personIds.length) return clone;
  const session = eligible[Math.floor(state.random() * eligible.length)]!;
  const presentation = session.presentations[Math.floor(state.random() * session.presentations.length)]!;
  presentation.questionerIds = state.pickQuestioners(presentation.presenterId, session.date,
    presentation.questionerIds.length || state.config.questionersPerPresenter);
  return clone;
}

export interface AnnealingSearch {
  initial: Session[];
  cost: CostContext;
  guidance: ConstraintGuidance;
  historicalSessions: Session[];
  unavailable: Map<string, Set<string>>;
  reference: Session[] | null;
  referenceWeight: number;
  propose: (current: Session[]) => Session[];
  random: RandomSource;
  maxIterations: number;
  diagnostics?: SolverDiagnostics;
}

export function runAnnealing(search: AnnealingSearch): Session[] {
  const started = performance.now();
  const totalCost = (sessions: Session[]) => computeCost(sessions, search.cost, search.guidance, search.historicalSessions)
    + (search.reference ? search.referenceWeight * hammingDistance(sessions, search.reference) : 0);
  let current = cloneSessions(search.initial);
  let currentCost = totalCost(current);
  let best = cloneSessions(current);
  let bestCost = currentCost;
  let stagnant = 0;
  let iterations = 0;
  let accepted = 0;
  let invalidNeighbors = 0;
  let unchangedNeighbors = 0;
  for (let iteration = 0; iteration < search.maxIterations; iteration++) {
    const temperature = ANNEALING_CONFIG.initialTemp * ANNEALING_CONFIG.coolingRate ** iteration;
    let neighbor: Session[] | null = null;
    const currentKey = JSON.stringify(current);
    for (let attempt = 0; attempt < 4; attempt++) {
      iterations++;
      const candidate = search.propose(current);
      if (validateAssignmentsWithContext(candidate, search.cost, search.guidance, search.unavailable).length) {
        invalidNeighbors++; continue;
      }
      if (JSON.stringify(candidate) === currentKey) { unchangedNeighbors++; continue; }
      neighbor = candidate;
      break;
    }
    if (!neighbor) { stagnant++; continue; }
    const neighborCost = totalCost(neighbor);
    const delta = neighborCost - currentCost;
    if (delta < 0 || search.random() < Math.exp(-delta / temperature)) {
      accepted++;
      current = neighbor;
      currentCost = neighborCost;
      if (currentCost < bestCost) {
        best = cloneSessions(current);
        bestCost = currentCost;
        stagnant = 0;
      } else stagnant++;
    } else stagnant++;
    if (stagnant >= ANNEALING_CONFIG.maxStagnantIter) break;
  }
  if (search.diagnostics) Object.assign(search.diagnostics, {
    initialCost: totalCost(search.initial), finalCost: bestCost,
    iterations, accepted, invalidNeighbors, unchangedNeighbors,
    durationMs: Math.round(performance.now() - started), restarts: 1,
  });
  return best;
}
