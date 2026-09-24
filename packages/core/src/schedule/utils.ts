import type { Person, ScheduleConfig, PersonUnavailability } from "../types.js";

/** Generate a standards-compliant cryptographically random UUID. */
export function generateId(): string {
  return crypto.randomUUID();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isISO8601(str: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return false;
  }
  const date = new Date(`${str}T00:00:00.000Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === str;
};

/** Return all ISO dates in [startDate, endDate] that fall on the configured days of week. */
export function generateSessionDates(config: Pick<ScheduleConfig, 'startDate' | 'endDate' | 'daysOfWeek'>): string[] {
  const dates: string[] = [];
  const end = new Date(config.endDate + 'T00:00:00Z');
  const cur = new Date(config.startDate + 'T00:00:00Z');
  while (cur <= end) {
    if (config.daysOfWeek.includes(cur.getUTCDay())) {
      dates.push(isoDate(cur));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/** Build a lookup: ISO date → Set of unavailable personIds for the given config. */
export function buildUnavailMap(
  unavailabilities: PersonUnavailability[],
  configId: string,
  persons: Person[],
  sessionDates: readonly string[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const active = persons.filter(person => !person.disabled);
  const activeIds = new Set(active.map(person => person.id));
  const dates = [...new Set(sessionDates)];
  for (const u of unavailabilities) {
    if (u.configId !== configId) continue;
    const tags = new Set(u.tagIds);
    const unavailablePersonIds = u.allPeople
      ? active.map(person => person.id)
      : [...u.personIds.filter(id => activeIds.has(id)), ...active.filter(person => person.tagIds?.some(tagId => tags.has(tagId))).map(person => person.id)];
    if (unavailablePersonIds.length === 0) continue;
    for (const key of dates) {
      if (key < u.startDate || key > u.endDate) continue;
      if (!map.has(key)) map.set(key, new Set());
      for (const personId of unavailablePersonIds) {
        map.get(key)!.add(personId);
      }
    }
  }
  return map;
}

/** Whole-group closure dates are omitted before assignment so no empty-candidate search runs. */
export function isWholeGroupClosure(date: string, unavailabilities: PersonUnavailability[], configId: string): boolean {
  return unavailabilities.some(item => item.configId === configId && item.allPeople
    && item.startDate <= date && date <= item.endDate);
}

export function validateUnavailability(value: PersonUnavailability): string[] {
  const errors: string[] = [];
  if (!value.configId || !isISO8601(value.startDate) || !isISO8601(value.endDate) || value.startDate > value.endDate)
    errors.push('Invalid inclusive unavailability date range');
  if (!Array.isArray(value.personIds) || value.personIds.some(id => typeof id !== 'string')
    || !Array.isArray(value.tagIds) || value.tagIds.some(id => typeof id !== 'string')
    || typeof value.allPeople !== 'boolean') errors.push('Invalid unavailability selectors');
  else if (value.allPeople ? value.personIds.length + value.tagIds.length > 0
    : value.personIds.length + value.tagIds.length === 0) errors.push('Choose people, tags, or everyone exclusively');
  return errors;
}
