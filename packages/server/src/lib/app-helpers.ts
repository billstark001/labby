import type { Person } from '@labby/core';

export function parsePagination(input: { offset?: string; limit?: string }): { offset: number; limit: number } {
  const rawOffset = Number.parseInt(input.offset ?? '0', 10);
  const rawLimit = Number.parseInt(input.limit ?? '20', 10);
  return {
    offset: Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0,
    limit: Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 20,
  };
}

export function toPage<T>(items: T[], offset: number, limit: number): { items: T[]; total: number; offset: number; limit: number } {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

export function toIsoDateFromEpoch(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function defaultIncrementalDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return toIsoDateFromEpoch(date.getTime());
}

export function defaultDisplayName(person: Person): string {
  if (person.name?.trim()) return person.name.trim();
  const anyName = Object.values(person.names ?? {}).find((value) => typeof value === 'string' && value.trim());
  return (typeof anyName === 'string' && anyName.trim()) ? anyName.trim() : `ID:${person.id}`;
}
