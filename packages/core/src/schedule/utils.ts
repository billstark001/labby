import { ScheduleConfig, PersonUnavailability, SchedulePlan } from "../types.js";

/** Generate a UUID-like string (not cryptographically strong). */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Return all ISO dates in [startDate, endDate] that fall on the configured days of week. */
export function generateSessionDates(config: ScheduleConfig): string[] {
  const dates: string[] = [];
  const end = new Date(config.endDate + 'T00:00:00Z');
  const cur = new Date(config.startDate + 'T00:00:00Z');
  while (cur <= end) {
    if (config.daysOfWeek.includes(cur.getUTCDay())) dates.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Build a lookup: ISO date → Set of unavailable personIds for the given config. */
export function buildUnavailMap(
  unavailabilities: PersonUnavailability[],
  configId: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const u of unavailabilities) {
    if (u.configId !== configId) continue;
    const [sy, sm, sd] = u.startDate.split('-').map(Number);
    const [ey, em, ed] = u.endDate.split('-').map(Number);
    const start = Date.UTC(sy, sm - 1, sd);
    const end = Date.UTC(ey, em - 1, ed);
    for (let t = start; t <= end; t += 86_400_000) {
      const d = new Date(t);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(u.personId);
    }
  }
  return map;
}

export function replaySessionMutationDates(baseDates: string[], plan: SchedulePlan): string[] {
  const records = [...(plan.sessionMutations ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const dates = [...baseDates];
  for (const rec of records) {
    const idx = dates.findIndex(d => d === rec.date);
    if (rec.action === 'delete') {
      if (idx >= 0) dates.splice(idx, 1);
      continue;
    }
    if (!rec.insertedDate || idx < 0) continue;
    dates.splice(rec.position === 'before' ? idx : idx + 1, 0, rec.insertedDate);
  }
  return dates;
}
