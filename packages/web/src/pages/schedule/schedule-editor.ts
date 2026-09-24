import { nanoid } from 'nanoid';
import type { SchedulePlan } from '@labby/core';

export type DraftPersonSlot =
  | { id: string; kind: 'fixed'; personId: string }
  | { id: string; kind: 'auto' };

export interface DraftPresentation {
  id: string;
  presenter: DraftPersonSlot;
  questioners: DraftPersonSlot[];
}

export interface DraftSession {
  id: string;
  date: string;
  presentations: DraftPresentation[];
}

export interface ScheduleDraft extends Omit<SchedulePlan, 'sessions'> {
  sessions: DraftSession[];
  discardedBefore: DraftPresentation[];
  discardedAfter: DraftPresentation[];
}

export interface PresentationLocation {
  zone: 'before' | 'session' | 'after';
  sessionIndex?: number;
  presentationIndex: number;
}

export function fixedSlot(personId: string): DraftPersonSlot {
  return { id: nanoid(), kind: 'fixed', personId };
}

export function autoSlot(): DraftPersonSlot {
  return { id: nanoid(), kind: 'auto' };
}

export function createAutoPresentation(questionerCount: number): DraftPresentation {
  return {
    id: nanoid(),
    presenter: autoSlot(),
    questioners: Array.from({ length: Math.max(0, questionerCount) }, autoSlot),
  };
}

export function createScheduleDraft(plan: SchedulePlan): ScheduleDraft {
  return {
    ...structuredClone(plan),
    sessions: plan.sessions.map(session => ({
      id: nanoid(),
      date: session.date,
      presentations: session.presentations.map(presentation => ({
        id: nanoid(),
        presenter: fixedSlot(presentation.presenterId),
        questioners: presentation.questionerIds.map(fixedSlot),
      })),
    })),
    discardedBefore: [],
    discardedAfter: [],
  };
}

export function cloneDraft(draft: ScheduleDraft): ScheduleDraft {
  return structuredClone(draft);
}

function presentationBuckets(draft: ScheduleDraft): DraftPresentation[][] {
  return [draft.discardedBefore, ...draft.sessions.map(session => session.presentations), draft.discardedAfter];
}

function sourceBucket(draft: ScheduleDraft, sessionIndex: number): DraftPresentation[] {
  return sessionIndex === 0 ? draft.discardedBefore : draft.sessions[sessionIndex - 1]!.presentations;
}

export function insertPresentation(
  draft: ScheduleDraft,
  sessionIndex: number,
  presentationIndex: number,
  questionerCount: number,
): ScheduleDraft {
  const next = cloneDraft(draft);
  const session = next.sessions[sessionIndex];
  if (!session || presentationIndex < 0 || presentationIndex > session.presentations.length) return draft;
  session.presentations.splice(presentationIndex, 0, createAutoPresentation(questionerCount));
  return next;
}

export function deletePresentation(draft: ScheduleDraft, presentationId: string): ScheduleDraft {
  const next = cloneDraft(draft);
  for (const bucket of presentationBuckets(next)) {
    const index = bucket.findIndex(presentation => presentation.id === presentationId);
    if (index >= 0) {
      bucket.splice(index, 1);
      return next;
    }
  }
  return draft;
}

export function reorderPresentations(
  draft: ScheduleDraft,
  sourceId: string,
  targetId: string,
  placement: 'before' | 'after',
): ScheduleDraft {
  if (sourceId === targetId) return draft;
  const next = cloneDraft(draft);
  const buckets = presentationBuckets(next);
  const lengths = buckets.map(bucket => bucket.length);
  const flat = buckets.flat();
  const sourceIndex = flat.findIndex(presentation => presentation.id === sourceId);
  if (sourceIndex < 0) return draft;
  const [moved] = flat.splice(sourceIndex, 1);
  const targetIndex = flat.findIndex(presentation => presentation.id === targetId);
  if (!moved || targetIndex < 0) return draft;
  flat.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, moved);

  let offset = 0;
  buckets.forEach((bucket, index) => {
    bucket.splice(0, bucket.length, ...flat.slice(offset, offset + lengths[index]!));
    offset += lengths[index]!;
  });
  return next;
}

export function movePresentationTo(
  draft: ScheduleDraft,
  sourceId: string,
  targetSessionIndex: number,
  targetPresentationIndex: number,
): ScheduleDraft {
  const targetSession = draft.sessions[targetSessionIndex];
  if (!targetSession || targetPresentationIndex < 0 || targetPresentationIndex > targetSession.presentations.length) return draft;

  const next = cloneDraft(draft);
  const buckets = presentationBuckets(next);
  const lengths = buckets.map(bucket => bucket.length);
  const flat = buckets.flat();
  const sourceIndex = flat.findIndex(presentation => presentation.id === sourceId);
  if (sourceIndex < 0) return draft;

  const targetIndex = next.discardedBefore.length
    + next.sessions.slice(0, targetSessionIndex).reduce((sum, session) => sum + session.presentations.length, 0)
    + targetPresentationIndex;
  const [moved] = flat.splice(sourceIndex, 1);
  if (!moved) return draft;
  flat.splice(Math.max(0, Math.min(targetIndex, flat.length)), 0, moved);

  let offset = 0;
  buckets.forEach((bucket, index) => {
    bucket.splice(0, bucket.length, ...flat.slice(offset, offset + lengths[index]!));
    offset += lengths[index]!;
  });
  return next;
}

export function moveBoundary(
  draft: ScheduleDraft,
  sessionIndex: number,
  direction: 'up' | 'down',
): ScheduleDraft {
  const next = cloneDraft(draft);
  const session = next.sessions[sessionIndex];
  if (!session) return draft;
  const previous = sourceBucket(next, sessionIndex);
  if (direction === 'up') {
    const moved = previous.pop();
    if (!moved) return draft;
    session.presentations.unshift(moved);
  } else {
    const moved = session.presentations.shift();
    if (!moved) return draft;
    previous.push(moved);
  }
  return next;
}

export function shiftSessionSuffix(
  draft: ScheduleDraft,
  sessionIndex: number,
  direction: 'up' | 'down',
  questionerCount: number,
): ScheduleDraft {
  const next = cloneDraft(draft);
  if (!next.sessions[sessionIndex]) return draft;
  const previous = sourceBucket(next, sessionIndex);

  if (direction === 'up') {
    let moving = previous.pop() ?? createAutoPresentation(questionerCount);
    for (let index = sessionIndex; index < next.sessions.length; index += 1) {
      const presentations = next.sessions[index]!.presentations;
      presentations.unshift(moving);
      moving = presentations.pop()!;
    }
    next.discardedAfter.unshift(moving);
    return next;
  }

  let moving = next.discardedAfter.shift() ?? createAutoPresentation(questionerCount);
  for (let index = next.sessions.length - 1; index >= sessionIndex; index -= 1) {
    const presentations = next.sessions[index]!.presentations;
    presentations.push(moving);
    moving = presentations.shift()!;
  }
  previous.push(moving);
  return next;
}

export function insertSession(
  draft: ScheduleDraft,
  index: number,
  date: string,
  presenterCount: number,
  questionerCount: number,
): ScheduleDraft {
  if (!date || draft.sessions.some(session => session.date === date)) return draft;
  const next = cloneDraft(draft);
  next.sessions.splice(index, 0, {
    id: nanoid(),
    date,
    presentations: Array.from({ length: Math.max(0, presenterCount) }, () => createAutoPresentation(questionerCount)),
  });
  next.sessions.sort((left, right) => left.date.localeCompare(right.date));
  return next;
}

/** Choose an editable, initially useful date between the neighbouring sessions. */
export function suggestedInsertDate(draft: ScheduleDraft, index: number, preferred: 'before' | 'after'): string | null {
  const previous = draft.sessions[index - 1]?.date;
  const following = draft.sessions[index]?.date;
  const day = 86_400_000;
  if (!previous && !following) return null;
  const previousTime = previous ? Date.parse(`${previous}T00:00:00Z`) : undefined;
  const followingTime = following ? Date.parse(`${following}T00:00:00Z`) : undefined;
  if (previousTime !== undefined && followingTime !== undefined && followingTime - previousTime <= day) return null;
  const time = previousTime === undefined ? followingTime! - 7 * day
    : followingTime === undefined ? previousTime + 7 * day
    : preferred === 'before' ? followingTime - day : previousTime + day;
  return new Date(time).toISOString().slice(0, 10);
}

/** Move one meeting to a new date without changing its presentation count. */
export function rescheduleSession(draft: ScheduleDraft, sessionId: string, date: string): ScheduleDraft {
  const index = draft.sessions.findIndex(session => session.id === sessionId);
  if (index < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return draft;
  if ((index > 0 && date <= draft.sessions[index - 1]!.date)
    || (index + 1 < draft.sessions.length && date >= draft.sessions[index + 1]!.date)) return draft;
  const next = cloneDraft(draft);
  next.sessions[index]!.date = date;
  return next;
}

/** Exchange two meetings while retaining the ordered calendar dates. */
export function swapAdjacentSessions(draft: ScheduleDraft, index: number, direction: -1 | 1): ScheduleDraft {
  const other = index + direction;
  if (!draft.sessions[index] || !draft.sessions[other]) return draft;
  const next = cloneDraft(draft);
  const currentRows = next.sessions[index]!.presentations;
  next.sessions[index]!.presentations = next.sessions[other]!.presentations;
  next.sessions[other]!.presentations = currentRows;
  return next;
}

/** Carry meeting n to the original date of meeting n+1, extending the final date. */
export function postponeSessionSuffix(draft: ScheduleDraft, index: number, finalDate: string): ScheduleDraft {
  if (!draft.sessions[index] || finalDate <= draft.sessions[draft.sessions.length - 1]!.date) return draft;
  const next = cloneDraft(draft);
  for (let i = index; i < next.sessions.length - 1; i++)
    next.sessions[i]!.date = draft.sessions[i + 1]!.date;
  next.sessions[next.sessions.length - 1]!.date = finalDate;
  return next;
}

export function nextConfiguredDateAfter(date: string, daysOfWeek: number[]): string {
  const next = new Date(`${date}T00:00:00Z`);
  for (let offset = 1; offset <= 7; offset++) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (daysOfWeek.includes(next.getUTCDay())) return next.toISOString().slice(0, 10);
  }
  throw new Error('No configured weekday is available');
}

/** Keep generation replay aligned with a manual change to the set of meeting dates. */
export function recordSessionDateChange(draft: ScheduleDraft, removedDate: string, addedDate: string): ScheduleDraft {
  if (removedDate === addedDate) return draft;
  const next = cloneDraft(draft);
  const existing = new Map((next.sessionMutations ?? []).map(item => [item.date, item]));
  const removed = existing.get(removedDate);
  if (removed?.action === 'insert') existing.delete(removedDate);
  else existing.set(removedDate, { date: removedDate, action: 'delete', createdAt: Date.now() });
  const added = existing.get(addedDate);
  if (added?.action === 'delete') existing.delete(addedDate);
  else existing.set(addedDate, { date: addedDate, action: 'insert', createdAt: Date.now() });
  next.sessionMutations = [...existing.values()].sort((a, b) => a.date.localeCompare(b.date));
  return next;
}

export function deleteSession(draft: ScheduleDraft, sessionId: string): ScheduleDraft {
  const next = cloneDraft(draft);
  const index = next.sessions.findIndex(session => session.id === sessionId);
  if (index < 0) return draft;
  const [removed] = next.sessions.splice(index, 1);
  next.discardedAfter.unshift(...removed!.presentations);
  return next;
}

export function replacePresenter(
  draft: ScheduleDraft,
  presentationId: string,
  personId: string | null,
): ScheduleDraft {
  const next = cloneDraft(draft);
  const presentation = presentationBuckets(next).flat().find(item => item.id === presentationId);
  if (!presentation) return draft;
  presentation.presenter = personId ? fixedSlot(personId) : autoSlot();
  presentation.questioners = presentation.questioners.filter(slot => slot.kind === 'auto' || slot.personId !== personId);
  return next;
}

export function addQuestioner(
  draft: ScheduleDraft,
  presentationId: string,
  personId: string | null,
  index?: number,
): ScheduleDraft {
  const next = cloneDraft(draft);
  const presentation = presentationBuckets(next).flat().find(item => item.id === presentationId);
  if (!presentation) return draft;
  const slot = personId ? fixedSlot(personId) : autoSlot();
  presentation.questioners.splice(index ?? presentation.questioners.length, 0, slot);
  return next;
}

export function replaceQuestioner(
  draft: ScheduleDraft,
  presentationId: string,
  slotId: string,
  personId: string | null,
): ScheduleDraft {
  const next = cloneDraft(draft);
  const presentation = presentationBuckets(next).flat().find(item => item.id === presentationId);
  const index = presentation?.questioners.findIndex(slot => slot.id === slotId) ?? -1;
  if (!presentation || index < 0) return draft;
  presentation.questioners[index] = personId ? fixedSlot(personId) : autoSlot();
  return next;
}

export function deleteQuestioner(draft: ScheduleDraft, presentationId: string, slotId: string): ScheduleDraft {
  const next = cloneDraft(draft);
  const presentation = presentationBuckets(next).flat().find(item => item.id === presentationId);
  if (!presentation) return draft;
  presentation.questioners = presentation.questioners.filter(slot => slot.id !== slotId);
  return next;
}

export function moveQuestioner(
  draft: ScheduleDraft,
  sourcePresentationId: string,
  slotId: string,
  targetPresentationId: string,
  targetIndex: number,
): ScheduleDraft {
  const next = cloneDraft(draft);
  const presentations = presentationBuckets(next).flat();
  const source = presentations.find(item => item.id === sourcePresentationId);
  const target = presentations.find(item => item.id === targetPresentationId);
  const sourceIndex = source?.questioners.findIndex(slot => slot.id === slotId) ?? -1;
  if (!source || !target || sourceIndex < 0) return draft;
  const [slot] = source.questioners.splice(sourceIndex, 1);
  if (!slot) return draft;
  const adjustedIndex = source === target && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  target.questioners.splice(Math.max(0, Math.min(adjustedIndex, target.questioners.length)), 0, slot);
  return next;
}

export function discardedPresentationCount(draft: ScheduleDraft): number {
  return draft.discardedBefore.length + draft.discardedAfter.length;
}
