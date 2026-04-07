import { Presentation, ScheduleSessionMutationRecord, Session, SimilarityLookup, SolverInput } from "../types.js";
import { buildRandomSchedule, RandomScheduleGenerator } from "./annealing.js";
import { buildCostContext } from "./constraints.js";
import { buildUnavailMap } from "./utils.js";

const dummySimilarityLookup: SimilarityLookup = {
  getPairSimilarity: () => 0.5,
}

export type MutateSessionsOptions = {
  index: number;
  tactic?: 'shift' | 'keep';
} & (
    | { operation: 'insert'; dates: string[]; count?: never }
    | { operation: 'delete'; count: number; dates?: never }
  )

export type ReplaySessionMutationOptions = {
  inPlace?: boolean; // whether to modify baseDates in place or return a new array
  startDate?: string; // optional ISO date to filter mutations (only apply mutations on or after this date)
}

export type MutatePresentationsOptions = {
  index: number;
  sessionIndex: number;
  operation: 'insert' | 'delete';
  count: number;
  mode?: 'session-resize' | 'shift-chain' | 'session-refill';
}

function assertPositiveCount(count: number): void {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Count must be a positive integer');
  }
}

function assertUniqueDates(dates: string[]): void {
  if (dates.length === 0) {
    throw new Error('Dates must not be empty');
  }
  const seen = new Set<string>();
  for (const date of dates) {
    if (!date) {
      throw new Error('Date must be non-empty');
    }
    if (seen.has(date)) {
      throw new Error(`Duplicate date in insert payload: ${date}`);
    }
    seen.add(date);
  }
}

function buildGeneratorContext(
  solverInput: Omit<SolverInput, 'similarities'> & { similarities?: SimilarityLookup },
) {
  const ctx = buildCostContext({
    ...solverInput,
    similarities: solverInput.similarities ?? dummySimilarityLookup,
  });
  const unavailMap = buildUnavailMap(solverInput.unavailabilities ?? [], solverInput.config.id);
  return {
    ctx,
    personIds: [...ctx.personKeywords.keys()],
    unavailMap,
  };
}

function buildDeleteMutations(removedSessions: Session[]): ScheduleSessionMutationRecord[] {
  const createdAt = Date.now();
  return removedSessions.map(s => ({
    date: s.date,
    action: 'delete' as const,
    createdAt,
  }));
}


export function replaySessionMutations(
  baseDates: string[],
  mutations: ScheduleSessionMutationRecord[],
  options: ReplaySessionMutationOptions = {},
): string[] {
  const datesToDelete = new Set<string>();
  const datesToInsert: string[] = [];

  const { inPlace = false, startDate } = options;

  for (const mut of mutations) {
    if (startDate && mut.date < startDate) {
      continue; // skip mutations before startDate
    }
    if (mut.action === 'delete') {
      datesToDelete.add(mut.date);
    } else {
      datesToInsert.push(mut.date);
    }
  }
  const dates = inPlace ? baseDates : [...baseDates];
  for (let i = dates.length - 1; i >= 0; i--) {
    if (datesToDelete.has(dates[i])) {
      dates.splice(i, 1);
    }
  }
  dates.splice(0, 0, ...datesToInsert).sort();
  return dates;
}

export function mergeMutationRecords(
  existing: ScheduleSessionMutationRecord[],
  newMutations: ScheduleSessionMutationRecord[],
): ScheduleSessionMutationRecord[] {
  const mutationMap = new Map<string, ScheduleSessionMutationRecord>();
  for (const mut of existing) {
    mutationMap.set(mut.date, mut);
  }
  for (const mut of newMutations) {
    mutationMap.set(mut.date, mut); // new mutations overwrite existing ones on the same date
  }
  return Array.from(mutationMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function mutateSessions(
  sessions: Session[],
  solverInput: Omit<SolverInput, 'similarities'> & { similarities?: SimilarityLookup },
  options: MutateSessionsOptions,
): {
  sessions: Session[];
  mutations: ScheduleSessionMutationRecord[];
} {
  const { index, operation, tactic = 'keep' } = options;

  const { mutations = [] } = solverInput;

  const isInsert = operation === 'insert';
  const isKeep = tactic === 'keep';
  const count = isInsert ? options.dates.length : options.count;

  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Index must be a non-negative integer');
  }
  assertPositiveCount(count);

  if (isInsert) {
    assertUniqueDates(options.dates);
  }

  if ((isInsert && isKeep && index > sessions.length) || (!isInsert && isKeep && index >= sessions.length)) {
    throw new Error('Index out of bounds');
  }

  if (!isInsert && count > sessions.length) {
    throw new Error('Count exceeds session length');
  }

  const newSessions = structuredClone(sessions);

  if (!isInsert) {
    if (count > (isKeep ? (newSessions.length - index) : newSessions.length)) {
      throw new Error('Count exceeds removable range');
    }

    const removeStart = isKeep ? index : (newSessions.length - count);
    const removed = newSessions.splice(removeStart, count);
    const mutationsToAdd = buildDeleteMutations(removed);

    return {
      sessions: newSessions,
      mutations: mergeMutationRecords(mutations, mutationsToAdd),
    };
  }

  const dates = options.dates;
  const { ctx, personIds, unavailMap } = buildGeneratorContext(solverInput);
  const historySessions = isKeep ? newSessions.slice(0, index) : newSessions;
  const generated = buildRandomSchedule(personIds, dates, solverInput.config, ctx, historySessions, unavailMap);

  let mergedSessions: Session[];
  if (isKeep) {
    mergedSessions = [
      ...newSessions.slice(0, index),
      ...generated,
      ...newSessions.slice(index),
    ];
  } else {
    mergedSessions = [...newSessions, ...generated];
  }

  const createdAt = Date.now();
  const newMutations = dates.map(d => ({
    date: d,
    action: 'insert' as const,
    createdAt,
  }));

  return {
    sessions: mergedSessions,
    mutations: mergeMutationRecords(mutations, newMutations),
  };

}

function generatePresentationsForSession(
  sessions: Session[],
  sessionIndex: number,
  count: number,
  solverInput: Omit<SolverInput, 'similarities'> & { similarities?: SimilarityLookup },
  existing: Presentation[],
): Presentation[] {
  const { ctx, personIds, unavailMap } = buildGeneratorContext(solverInput);
  const target = sessions[sessionIndex];
  const blockedPresenters = new Set(existing.map(p => p.presenterId));
  const filteredPersonIds = personIds.filter(id => !blockedPresenters.has(id));

  if (filteredPersonIds.length === 0) {
    return [];
  }

  const historySessions = sessions.slice(0, sessionIndex);
  const generator = new RandomScheduleGenerator(
    filteredPersonIds,
    solverInput.config,
    ctx,
    historySessions,
    unavailMap,
  );
  return generator.generate(target.date, count);
}

function cascadeOverflowForward(
  sessions: Session[],
  startIndex: number,
  baselineLengths: number[],
): void {
  for (let i = startIndex; i < sessions.length - 1; i++) {
    const current = sessions[i]?.presentations;
    const next = sessions[i + 1]?.presentations;
    if (!current || !next) continue;

    const expectedLength = baselineLengths[i] ?? current.length;
    const overflowCount = current.length - expectedLength;
    if (overflowCount <= 0) continue;

    const overflow = current.splice(expectedLength, overflowCount);
    next.splice(0, 0, ...overflow);
  }

  const lastIndex = sessions.length - 1;
  if (lastIndex < 0) return;
  const lastExpected = baselineLengths[lastIndex] ?? sessions[lastIndex].presentations.length;
  const lastOverflow = sessions[lastIndex].presentations.length - lastExpected;
  if (lastOverflow > 0) {
    sessions[lastIndex].presentations.splice(lastExpected, lastOverflow);
  }
}

function cascadeDeficitBackward(
  sessions: Session[],
  startIndex: number,
  baselineLengths: number[],
): void {
  for (let i = startIndex; i < sessions.length - 1; i++) {
    const current = sessions[i]?.presentations;
    const next = sessions[i + 1]?.presentations;
    if (!current || !next) continue;

    const expectedLength = baselineLengths[i] ?? current.length;
    const deficit = expectedLength - current.length;
    if (deficit <= 0) continue;

    const moved = next.splice(0, deficit);
    current.push(...moved);
  }
}

function refillSessionTail(
  sessions: Session[],
  sessionIndex: number,
  count: number,
  solverInput: Omit<SolverInput, 'similarities'> & { similarities?: SimilarityLookup },
): void {
  if (count <= 0) return;

  const target = sessions[sessionIndex];
  const generated = generatePresentationsForSession(
    sessions,
    sessionIndex,
    count,
    solverInput,
    target.presentations,
  );
  if (generated.length < count) {
    throw new Error('Insufficient eligible people to regenerate deleted presentations');
  }
  target.presentations.push(...generated);
}

export function mutatePresentations(
  sessions: Session[],
  solverInput: Omit<SolverInput, 'similarities'> & { similarities?: SimilarityLookup },
  options: MutatePresentationsOptions,
): Session[] {
  const {
    sessionIndex,
    index,
    operation,
    count,
    mode = 'session-resize',
  } = options;

  if (!Number.isInteger(sessionIndex) || sessionIndex < 0 || sessionIndex >= sessions.length) {
    throw new Error('Session index out of bounds');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Index must be a non-negative integer');
  }
  assertPositiveCount(count);

  const isInsert = operation === 'insert';
  const baselineLengths = sessions.map(s => s.presentations.length);

  const nextSessions = structuredClone(sessions);
  const target = nextSessions[sessionIndex];
  const presentations = target.presentations;

  if (isInsert && index > presentations.length) {
    throw new Error('Presentation index out of bounds');
  }
  if (!isInsert && index >= presentations.length) {
    throw new Error('Presentation index out of bounds');
  }
  if (!isInsert && count > presentations.length) {
    throw new Error('Count exceeds presentation length');
  }
  if (!isInsert && index + count > presentations.length) {
    throw new Error('Count exceeds removable range');
  }

  const deleteStart = index;
  const insertAt = index;

  if (isInsert) {
    const generated = generatePresentationsForSession(nextSessions, sessionIndex, count, solverInput, presentations);
    if (generated.length < count) {
      throw new Error('Insufficient eligible people to generate requested presentations');
    }

    presentations.splice(insertAt, 0, ...generated);

    if (mode !== 'session-resize') {
      cascadeOverflowForward(nextSessions, sessionIndex, baselineLengths);
    }

    return nextSessions;
  }

  const removed = presentations.splice(deleteStart, count);
  if (removed.length < count) {
    throw new Error('Failed to remove requested number of presentations');
  }

  if (mode === 'shift-chain') {
      cascadeDeficitBackward(nextSessions, sessionIndex, baselineLengths);
      const lastIndex = nextSessions.length - 1;
      if (lastIndex >= 0) {
        const expectedLength = baselineLengths[lastIndex] ?? nextSessions[lastIndex].presentations.length;
        const deficit = expectedLength - nextSessions[lastIndex].presentations.length;
        refillSessionTail(nextSessions, lastIndex, deficit, solverInput);
    }
  } else if (mode === 'session-refill') {
    refillSessionTail(nextSessions, sessionIndex, count, solverInput);
  }

  return nextSessions;
}