import type { ScheduleConfig, SchedulePlan, Session } from '../types.js';
import { getEnvironmentTimeZone, getTimeZoneOffsetMinutes, normalizeTimeZone } from '../timezone.js';
import { resolveSessionTimeRange } from './session.js';

export type ScheduleUnit = 'semester' | 'session' | 'week' | 'month' | 'quarter';
export type ScheduleSelectionUnit = ScheduleUnit | `${ScheduleUnit}s`;

export interface ScheduleSelectionOptions {
  unit?: ScheduleSelectionUnit;
  amount?: number;
  /** UTC timestamp used consistently for the next meeting and rolling windows. */
  anchorTime?: number;
  config?: ScheduleConfig;
  timeZone?: string;
}

export function resolveScheduleTimeZone(options: Pick<ScheduleSelectionOptions, 'config' | 'timeZone'>): string {
  return normalizeTimeZone(options.config?.timezone) ?? normalizeTimeZone(options.timeZone) ?? getEnvironmentTimeZone();
}

/** Convert a schedule-local wall clock to its UTC timestamp (also used by ICS). */
export function scheduleLocalInstant(date: string, time: string, timeZone: string): number {
  const localAsUtc = Date.parse(`${date}T${time}:00Z`);
  let offset = getTimeZoneOffsetMinutes(timeZone, new Date(localAsUtc)) ?? 0;
  let instant = localAsUtc - offset * 60_000;
  offset = getTimeZoneOffsetMinutes(timeZone, new Date(instant)) ?? offset;
  instant = localAsUtc - offset * 60_000;
  return instant;
}

export function sessionStartInstant(session: Session, options: ScheduleSelectionOptions = {}): number {
  return scheduleLocalInstant(session.date, resolveSessionTimeRange(session, options.config)[0], resolveScheduleTimeZone(options));
}

function windowEnd(anchorTime: number, unit: 'week' | 'month' | 'quarter', amount: number, timeZone: string): number {
  // Calendar windows retain the schedule-local clock across DST and clamp month ends.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(anchorTime));
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === name)!.value);
  const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  if (unit === 'week') date.setUTCDate(date.getUTCDate() + amount * 7);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + amount * (unit === 'quarter' ? 3 : 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  const clock = `${String(part('hour')).padStart(2, '0')}:${String(part('minute')).padStart(2, '0')}`;
  return scheduleLocalInstant(date.toISOString().slice(0, 10), clock, timeZone)
    + part('second') * 1000 + anchorTime % 1000;
}

/** Semester exports include the whole plan; other units select upcoming starts. */
export function pickSessions(plan: SchedulePlan, options: ScheduleSelectionOptions = {}): Session[] {
  const requestedUnit = options.unit ?? 'semester';
  const unit = requestedUnit.endsWith('s') ? requestedUnit.slice(0, -1) : requestedUnit;
  if (!['semester', 'session', 'week', 'month', 'quarter'].includes(unit)) {
    throw new Error(`Invalid schedule unit: ${requestedUnit}`);
  }
  const amount = options.amount ?? 1;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Schedule amount must be a positive integer');
  const anchorTime = options.anchorTime ?? Date.now();
  if (!Number.isFinite(anchorTime)) throw new Error('Invalid schedule anchor time');
  const timeZone = resolveScheduleTimeZone(options);
  const sessions = plan.sessions.map(session => ({ session, start: sessionStartInstant(session, { ...options, timeZone }) }))
    .sort((left, right) => left.start - right.start);
  if (unit === 'semester') return sessions.map(item => item.session);
  const upcoming = sessions.filter(item => item.start >= anchorTime);
  if (unit === 'session') return upcoming.slice(0, amount).map(item => item.session);
  const end = windowEnd(anchorTime, unit as 'week' | 'month' | 'quarter', amount, timeZone);
  return upcoming.filter(item => item.start < end).map(item => item.session);
}
