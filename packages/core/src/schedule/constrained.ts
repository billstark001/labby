import type {
  ConstrainedSolverInput,
  ScheduleTemplatePresentation,
  Session,
} from '../types.js';
import {
  buildConstraintGuidance,
  buildCostContext,
  computeCost,
  noOverlapForbidden,
} from './constraints.js';
import { ANNEALING_CONFIG } from './annealing.js';
import { buildUnavailMap } from './utils.js';

interface SlotMask {
  presenterAuto: boolean;
  questionerAuto: boolean[];
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function solveConstrained(input: ConstrainedSolverInput): Session[] {
  const activeIds = input.persons.filter(person => !person.disabled).map(person => person.id);
  const activeSet = new Set(activeIds);
  if (activeIds.length === 0) throw new Error('No active people are available');

  const ctx = buildCostContext(input);
  const guidance = buildConstraintGuidance(ctx);
  const unavailability = buildUnavailMap(input.unavailabilities ?? [], input.config.id);
  const masks: SlotMask[][] = input.template.map(session => session.presentations.map(presentation => ({
    presenterAuto: presentation.presenterId === null,
    questionerAuto: presentation.questionerIds.map(id => id === null),
  })));

  const sessions: Session[] = input.template.map(session => ({
    date: session.date,
    presentations: session.presentations.map(presentation => ({
      presenterId: presentation.presenterId ?? '',
      questionerIds: presentation.questionerIds.map(id => id ?? ''),
    })),
  }));

  const presenterCandidates = (
    sessionIndex: number,
    presentationIndex: number,
    template: ScheduleTemplatePresentation,
  ): string[] => {
    const session = sessions[sessionIndex]!;
    const unavailable = unavailability.get(session.date) ?? new Set<string>();
    const occupied = new Set(session.presentations
      .filter((_, index) => index !== presentationIndex)
      .map(presentation => presentation.presenterId)
      .filter(Boolean));
    const fixedQuestioners = template.questionerIds.filter((id): id is string => id !== null);
    return activeIds.filter(id =>
      !unavailable.has(id)
      && !occupied.has(id)
      && fixedQuestioners.every(questionerId => questionerId !== id && !noOverlapForbidden(id, questionerId, guidance)),
    );
  };

  const questionerCandidates = (
    sessionIndex: number,
    presentationIndex: number,
    questionerIndex: number,
  ): string[] => {
    const session = sessions[sessionIndex]!;
    const presentation = session.presentations[presentationIndex]!;
    const unavailable = unavailability.get(session.date) ?? new Set<string>();
    const occupied = new Set(presentation.questionerIds.filter((_, index) => index !== questionerIndex).filter(Boolean));
    return activeIds.filter(id =>
      id !== presentation.presenterId
      && !unavailable.has(id)
      && !occupied.has(id)
      && !noOverlapForbidden(presentation.presenterId, id, guidance),
    );
  };

  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
    const session = sessions[sessionIndex]!;
    const templateSession = input.template[sessionIndex]!;
    const unavailable = unavailability.get(session.date) ?? new Set<string>();
    const fixedPresenters = new Set<string>();
    for (let presentationIndex = 0; presentationIndex < session.presentations.length; presentationIndex += 1) {
      const template = templateSession.presentations[presentationIndex]!;
      if (template.presenterId !== null) {
        if (!activeSet.has(template.presenterId) || unavailable.has(template.presenterId)) {
          throw new Error(`Fixed presenter ${template.presenterId} is unavailable on ${session.date}`);
        }
        if (fixedPresenters.has(template.presenterId)) {
          throw new Error(`Presenter ${template.presenterId} appears twice on ${session.date}`);
        }
        fixedPresenters.add(template.presenterId);
      }
    }

    for (let presentationIndex = 0; presentationIndex < session.presentations.length; presentationIndex += 1) {
      const presentation = session.presentations[presentationIndex]!;
      const template = templateSession.presentations[presentationIndex]!;
      if (template.presenterId === null) {
        const candidates = presenterCandidates(sessionIndex, presentationIndex, template);
        if (!candidates.length) throw new Error(`No eligible Auto presenter is available on ${session.date}`);
        presentation.presenterId = randomItem(candidates);
      }

      const fixedQuestioners = new Set<string>();
      for (let questionerIndex = 0; questionerIndex < template.questionerIds.length; questionerIndex += 1) {
        const fixedId = template.questionerIds[questionerIndex];
        if (fixedId === null) continue;
        if (
          !activeSet.has(fixedId)
          || unavailable.has(fixedId)
          || fixedId === presentation.presenterId
          || fixedQuestioners.has(fixedId)
          || noOverlapForbidden(presentation.presenterId, fixedId, guidance)
        ) {
          throw new Error(`Fixed questioner ${fixedId} is invalid on ${session.date}`);
        }
        fixedQuestioners.add(fixedId);
      }
      for (let questionerIndex = 0; questionerIndex < presentation.questionerIds.length; questionerIndex += 1) {
        if (template.questionerIds[questionerIndex] !== null) continue;
        const candidates = questionerCandidates(sessionIndex, presentationIndex, questionerIndex);
        if (!candidates.length) throw new Error(`No eligible Auto questioner is available on ${session.date}`);
        presentation.questionerIds[questionerIndex] = randomItem(candidates);
      }
    }
  }

  type MutableSlot =
    | { kind: 'presenter'; sessionIndex: number; presentationIndex: number }
    | { kind: 'questioner'; sessionIndex: number; presentationIndex: number; questionerIndex: number };
  const mutableSlots: MutableSlot[] = [];
  masks.forEach((session, sessionIndex) => session.forEach((mask, presentationIndex) => {
    if (mask.presenterAuto) mutableSlots.push({ kind: 'presenter', sessionIndex, presentationIndex });
    mask.questionerAuto.forEach((isAuto, questionerIndex) => {
      if (isAuto) mutableSlots.push({ kind: 'questioner', sessionIndex, presentationIndex, questionerIndex });
    });
  }));
  if (!mutableSlots.length) return sessions;

  const totalCost = (candidate: Session[]) => computeCost(candidate, ctx, guidance, input.historicalSessions ?? []);
  let current = structuredClone(sessions);
  let currentCost = totalCost(current);
  let best = structuredClone(current);
  let bestCost = currentCost;
  let stagnantIterations = 0;

  for (let iteration = 0; iteration < ANNEALING_CONFIG.maxIter; iteration += 1) {
    sessions.splice(0, sessions.length, ...structuredClone(current));
    const slot = randomItem(mutableSlots);
    const presentation = sessions[slot.sessionIndex]!.presentations[slot.presentationIndex]!;
    if (slot.kind === 'presenter') {
      const candidates = presenterCandidates(
        slot.sessionIndex,
        slot.presentationIndex,
        input.template[slot.sessionIndex]!.presentations[slot.presentationIndex]!,
      ).filter(id => id !== presentation.presenterId);
      if (!candidates.length) continue;
      presentation.presenterId = randomItem(candidates);
      for (let questionerIndex = 0; questionerIndex < presentation.questionerIds.length; questionerIndex += 1) {
        if (!masks[slot.sessionIndex]![slot.presentationIndex]!.questionerAuto[questionerIndex]) continue;
        const candidatesForQuestioner = questionerCandidates(slot.sessionIndex, slot.presentationIndex, questionerIndex);
        if (candidatesForQuestioner.length) presentation.questionerIds[questionerIndex] = randomItem(candidatesForQuestioner);
      }
    } else {
      const candidates = questionerCandidates(slot.sessionIndex, slot.presentationIndex, slot.questionerIndex)
        .filter(id => id !== presentation.questionerIds[slot.questionerIndex]);
      if (!candidates.length) continue;
      presentation.questionerIds[slot.questionerIndex] = randomItem(candidates);
    }

    const neighbor = structuredClone(sessions);
    const neighborCost = totalCost(neighbor);
    const temperature = ANNEALING_CONFIG.initialTemp * ANNEALING_CONFIG.coolingRate ** iteration;
    if (neighborCost < currentCost || Math.random() < Math.exp((currentCost - neighborCost) / temperature)) {
      current = neighbor;
      currentCost = neighborCost;
    }
    if (currentCost < bestCost) {
      best = structuredClone(current);
      bestCost = currentCost;
      stagnantIterations = 0;
    } else {
      stagnantIterations += 1;
    }
    if (stagnantIterations >= ANNEALING_CONFIG.maxStagnantIter) break;
  }
  return best;
}
