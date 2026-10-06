import type { ScheduleConfig, Session, Presentation } from '../types.js';

export type SessionDetails = Pick<Session, 'notes' | 'timeRange'>;
export type SessionTimeRange = NonNullable<Session['timeRange']>;

/** Resolve one occurrence's schedule-local times without constructing a config. */
export function resolveSessionTimeRange(session: SessionDetails, config?: Pick<ScheduleConfig, 'timeRange'>): SessionTimeRange {
  const times = session.timeRange ?? config?.timeRange;
  return times ? [times[0], times[1]] : ['09:00', '10:00'];
}

/** Copy occurrence settings without sharing the mutable time tuple. */
export function copySessionDetails(target: SessionDetails, source: SessionDetails): void {
  target.notes = source.notes;
  target.timeRange = source.timeRange ? [source.timeRange[0], source.timeRange[1]] : undefined;
}

function clonePresentation(presentation: Presentation): Presentation {
  return { presenterId: presentation.presenterId, questionerIds: presentation.questionerIds.slice() };
}

export function cloneSession(session: Session): Session {
  const result: Session = { date: session.date, presentations: session.presentations.map(clonePresentation) };
  copySessionDetails(result, session);
  return result;
}

/** Keep settings attached to their dates after the solver rebuilds assignments. */
export function restoreSessionDetails(sessions: Session[], previousSessions: Session[]): Session[] {
  const previousByDate = new Map<string, Session>();
  for (const session of previousSessions) previousByDate.set(session.date, session);
  const result: Session[] = [];
  for (const session of sessions) {
    const restored = cloneSession(session);
    const previous = previousByDate.get(session.date);
    if (previous) copySessionDetails(restored, previous);
    result.push(restored);
  }
  return result;
}

/** Overnight ranges are valid; identical start and end times are not. */
export function isValidSessionTimeRange(times: SessionTimeRange): boolean {
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  return clock.test(times[0]) && clock.test(times[1]) && times[0] !== times[1];
}

export function formatSessionDetailsSummary(session: SessionDetails): string {
  const times = session.timeRange?.join('–') ?? '';
  const notes = session.notes ?? '';
  return times && notes ? `${times} · ${notes}` : times || notes;
}
