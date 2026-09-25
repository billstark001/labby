/** Focused schedule moves. Each function returns a fresh schedule and leaves its input untouched. */
import type { Presentation, Session } from '../types.js';
import {
  affinityPairWeight, computeCostBreakdown, noOverlapForbidden, personGapCost,
  validateAssignmentsWithContext, weightedTotalCost,
  type ConstraintGuidance, type CostContext,
} from './constraints.js';
import {
  cloneSessions, expectedPresenterCounts, presenterCounts,
  type RandomSource, type StrategyContext,
} from './strategy-utils.js';

export function targetFrequency(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const { personIds, guidance, unavailable, config, pickQuestioners, random } = state;
  const all = [...state.historicalSessions, ...clone];
  if (!all.length || !personIds.length) return clone;
  const counts = presenterCounts(all, personIds);
  const total = personIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
  const expected = expectedPresenterCounts(total, personIds, guidance);
  const deviations = personIds.map(id => ({ id, deviation: (counts.get(id) ?? 0) - (expected.get(id) ?? 0) }))
    .sort((a, b) => a.deviation - b.deviation);
  const under = deviations[0]!;
  const over = deviations[deviations.length - 1]!;
  if (over.deviation < 1 || under.deviation > -1) return clone;
  for (let attempt = 0; attempt < 30; attempt++) {
    const session = clone[Math.floor(random() * clone.length)]!;
    if (unavailable.get(session.date)?.has(under.id)) continue;
    const index = session.presentations.findIndex(presentation => presentation.presenterId === over.id);
    if (index < 0 || session.presentations.some(presentation => presentation.presenterId === under.id)) continue;
    const presentation = session.presentations[index]!;
    presentation.presenterId = under.id;
    presentation.questionerIds = pickQuestioners(under.id, session.date,
      presentation.questionerIds.length || config.questionersPerPresenter);
    break;
  }
  return clone;
}

export function targetPresenterGap(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const { personIds, cost, unavailable, config, pickQuestioners, random } = state;
  const all = [...state.historicalSessions, ...clone];
  const dates = all.map(session => Date.parse(`${session.date}T00:00:00Z`) / 86400000);
  if (dates.length < 2) return clone;
  const ordered = [...dates].sort((a, b) => a - b);
  const spacings = ordered.slice(1).map((day, index) => day - ordered[index]!).sort((a, b) => a - b);
  const nominal = spacings[Math.floor(spacings.length / 2)] ?? 7;
  const first = ordered[0]! - nominal / 2;
  const last = ordered[ordered.length - 1]! + nominal / 2;
  const appearancesByPerson = new Map<string, number[]>();
  const slotsByPerson = new Map(personIds.map(id => [id, [] as Array<{ session: Session; index: number; day: number }>]));
  const mutable = new Set(clone);
  all.forEach((session, sessionIndex) => session.presentations.forEach((presentation, index) => {
    slotsByPerson.get(presentation.presenterId)?.push({ session, index, day: dates[sessionIndex]! });
  }));
  const clustered: Array<{ session: Session; index: number; id: string; ratio: number }> = [];
  for (const id of personIds) {
    const appearances = slotsByPerson.get(id)!.sort((a, b) => a.day - b.day);
    appearancesByPerson.set(id, appearances.map(item => item.day));
    const target = (last - first) / (appearances.length + 1);
    for (let index = 1; index < appearances.length; index++) {
      const later = appearances[index]!;
      if (!mutable.has(later.session)) continue;
      const ratio = (later.day - appearances[index - 1]!.day) / Math.max(1, target);
      if (ratio < Math.max(0.9, cost.gapBalance.presenter.shortGapRatio))
        clustered.push({ session: later.session, index: later.index, id, ratio });
    }
  }
  if (!clustered.length) return clone;
  clustered.sort((a, b) => a.ratio - b.ratio);
  const source = clustered[Math.floor(random() * Math.min(3, clustered.length))]!;
  const sourceDay = Date.parse(`${source.session.date}T00:00:00Z`) / 86400000;
  const sourceDays = appearancesByPerson.get(source.id)!;
  const beforeSource = personGapCost(sourceDays, first, last, cost.gapBalance.presenter);
  const replaceDay = (values: number[], from: number, to: number) => {
    const next = [...values];
    const index = next.indexOf(from);
    if (index >= 0) next[index] = to;
    return next;
  };
  const candidates: Array<{ session: Session; index: number; gain: number }> = [];
  const occupied = new Set(source.session.presentations.map(presentation => presentation.presenterId));
  const beforeByPerson = new Map<string, number>();
  for (const session of clone) {
    if (session === source.session || unavailable.get(session.date)?.has(source.id)) continue;
    if (session.presentations.some(presentation => presentation.presenterId === source.id)) continue;
    const candidateDay = Date.parse(`${session.date}T00:00:00Z`) / 86400000;
    const sourceAfter = personGapCost(replaceDay(sourceDays, sourceDay, candidateDay), first, last, cost.gapBalance.presenter);
    for (let index = 0; index < session.presentations.length; index++) {
      const otherId = session.presentations[index]!.presenterId;
      if (occupied.has(otherId) || unavailable.get(source.session.date)?.has(otherId)) continue;
      const otherDays = appearancesByPerson.get(otherId);
      if (!otherDays) continue;
      let beforeOther = beforeByPerson.get(otherId);
      if (beforeOther === undefined) {
        beforeOther = personGapCost(otherDays, first, last, cost.gapBalance.presenter);
        beforeByPerson.set(otherId, beforeOther);
      }
      const gain = beforeSource + beforeOther - sourceAfter
        - personGapCost(replaceDay(otherDays, candidateDay, sourceDay), first, last, cost.gapBalance.presenter);
      if (gain > 0.001) candidates.push({ session, index, gain });
    }
  }
  if (!candidates.length) return clone;
  candidates.sort((a, b) => b.gain - a.gain);
  const chosen = candidates[Math.floor(random() * Math.min(3, candidates.length))]!;
  const sourcePresentation = source.session.presentations[source.index]!;
  const otherPresentation = chosen.session.presentations[chosen.index]!;
  const otherId = otherPresentation.presenterId;
  sourcePresentation.presenterId = otherId;
  otherPresentation.presenterId = source.id;
  sourcePresentation.questionerIds = pickQuestioners(otherId, source.session.date,
    sourcePresentation.questionerIds.length || config.questionersPerPresenter);
  otherPresentation.questionerIds = pickQuestioners(source.id, chosen.session.date,
    otherPresentation.questionerIds.length || config.questionersPerPresenter);
  return clone;
}

export function targetReciprocal(state: StrategyContext): Session[] {
  const clone = cloneSessions(state.sessions);
  const { personIds, guidance, unavailable, random } = state;
  const reciprocal: Array<{ session: Session; presentation: Presentation; questionerIndex: number }> = [];
  for (const session of clone) {
    const pairs = new Set(session.presentations.flatMap(presentation =>
      presentation.questionerIds.map(id => `${presentation.presenterId}|${id}`)));
    for (const presentation of session.presentations)
      presentation.questionerIds.forEach((id, questionerIndex) => {
        if (pairs.has(`${id}|${presentation.presenterId}`)) reciprocal.push({ session, presentation, questionerIndex });
      });
  }
  if (!reciprocal.length) return clone;
  const { session, presentation, questionerIndex } = reciprocal[Math.floor(random() * reciprocal.length)]!;
  const absent = unavailable.get(session.date) ?? new Set<string>();
  const occupied = new Set(presentation.questionerIds);
  const reversePresenters = new Set(session.presentations
    .filter(other => other.questionerIds.includes(presentation.presenterId)).map(other => other.presenterId));
  const candidates = personIds.filter(id => id !== presentation.presenterId && !occupied.has(id)
    && !absent.has(id) && !reversePresenters.has(id)
    && !noOverlapForbidden(presentation.presenterId, id, guidance));
  if (!candidates.length) return clone;
  candidates.sort((a, b) => affinityPairWeight(presentation.presenterId, b, guidance)
    - affinityPairWeight(presentation.presenterId, a, guidance));
  presentation.questionerIds[questionerIndex] = candidates[Math.floor(random() * Math.min(3, candidates.length))]!;
  return clone;
}

interface QuestionerSlot { session: number; presentation: number; questioner: number }

function questionerRepairScore(cost: CostContext, guidance: ConstraintGuidance, historical: Session[]) {
  const policy = cost.questionerOptimization.repair;
  return (candidate: Session[]): number => {
    const breakdown = computeCostBreakdown(candidate, cost, guidance, historical);
    return weightedTotalCost(breakdown, cost.costWeights)
      + policy.pairWeight * breakdown.questionerPenalty
      + policy.countWeight * breakdown.questionerCountPenalty;
  };
}

function rankedQuestionerSlots(
  current: Session[], historical: Session[], slots: QuestionerSlot[], ids: string[],
  cost: CostContext, guidance: ConstraintGuidance,
): QuestionerSlot[] {
  const policy = cost.questionerOptimization.repair;
  const counts = new Map(ids.map(id => [id, 0]));
  const pairCounts = new Map<string, number>();
  for (const session of [...historical, ...current]) for (const presentation of session.presentations)
    for (const questioner of presentation.questionerIds) {
      counts.set(questioner, (counts.get(questioner) ?? 0) + 1);
      const key = `${questioner}→${presentation.presenterId}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  const normalized = ids.map(id => (counts.get(id) ?? 0) / Math.max(0.01, guidance.questionerWeights.get(id) ?? 1));
  const mean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const priority = (slot: QuestionerSlot): number => {
    const presentation = current[slot.session]!.presentations[slot.presentation]!;
    const id = presentation.questionerIds[slot.questioner]!;
    const pair = pairCounts.get(`${id}→${presentation.presenterId}`) ?? 0;
    const load = (counts.get(id) ?? 0) / Math.max(0.01, guidance.questionerWeights.get(id) ?? 1);
    return policy.pairWeight * Math.max(0, pair - 1) + policy.countWeight * Math.max(0, load - mean);
  };
  return slots.filter(slot => priority(slot) > 0).sort((left, right) => priority(right) - priority(left));
}

function* questionerCandidates(
  current: Session[], target: QuestionerSlot, slots: QuestionerSlot[], ids: string[],
  unavailable: Map<string, Set<string>>, iteration: number,
): Generator<Session[]> {
  const source = current[target.session]!.presentations[target.presentation]!;
  const oldQuestioner = source.questionerIds[target.questioner]!;
  for (const id of ids) {
    if (id === oldQuestioner || id === source.presenterId || unavailable.get(current[target.session]!.date)?.has(id)) continue;
    const candidate = cloneSessions(current);
    candidate[target.session]!.presentations[target.presentation]!.questionerIds[target.questioner] = id;
    yield candidate;
  }
  for (let offset = 0; offset < Math.min(32, slots.length); offset++) {
    const other = slots[(iteration * 17 + offset * 7) % slots.length]!;
    if (other.session === target.session && other.presentation === target.presentation && other.questioner === target.questioner) continue;
    const second = current[other.session]!.presentations[other.presentation]!.questionerIds[other.questioner]!;
    if (second === oldQuestioner) continue;
    const candidate = cloneSessions(current);
    candidate[target.session]!.presentations[target.presentation]!.questionerIds[target.questioner] = second;
    candidate[other.session]!.presentations[other.presentation]!.questionerIds[other.questioner] = oldQuestioner;
    yield candidate;
  }
}

function bestQuestionerCandidate(
  candidates: Iterable<Session[]>, currentScore: number, score: (sessions: Session[]) => number,
  cost: CostContext, guidance: ConstraintGuidance, unavailable: Map<string, Set<string>>,
): { sessions: Session[]; score: number } | null {
  let best: { sessions: Session[]; score: number } | null = null;
  let bestScore = currentScore;
  for (const candidate of candidates) {
    if (validateAssignmentsWithContext(candidate, cost, guidance, unavailable).length) continue;
    const candidateScore = score(candidate);
    if (candidateScore < bestScore - 1e-6) {
      best = { sessions: candidate, score: candidateScore };
      bestScore = candidateScore;
    }
  }
  return best;
}

/** Post-search questioner repair, scored against the ordinary objective plus local emphases. */
export function repairQuestioners(
  sessions: Session[], historical: Session[], cost: CostContext, guidance: ConstraintGuidance,
  unavailable: Map<string, Set<string>>, random: RandomSource,
): Session[] {
  const policy = cost.questionerOptimization.repair;
  if (policy.iterations <= 0 || (policy.pairWeight <= 0 && policy.countWeight <= 0)) return sessions;
  const slots: QuestionerSlot[] = sessions.flatMap((session, si) => session.presentations.flatMap((presentation, pi) =>
    presentation.questionerIds.map((_, qi) => ({ session: si, presentation: pi, questioner: qi }))));
  if (!slots.length) return sessions;
  const ids = [...cost.personKeywords.keys()];
  const score = questionerRepairScore(cost, guidance, historical);
  let current = cloneSessions(sessions);
  let currentScore = score(current);
  let failures = 0;

  for (let iteration = 0; iteration < policy.iterations && failures < 24; iteration++) {
    const targets = rankedQuestionerSlots(current, historical, slots, ids, cost, guidance);
    if (!targets.length) break;
    const target = targets[Math.floor(random() * Math.min(5, targets.length))]!;
    const best = bestQuestionerCandidate(questionerCandidates(current, target, slots, ids, unavailable, iteration),
      currentScore, score, cost, guidance, unavailable);
    if (best) { current = best.sessions; currentScore = best.score; failures = 0; }
    else failures++;
  }
  return current;
}
