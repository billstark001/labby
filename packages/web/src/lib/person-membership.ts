import type { Person } from '@labby/core';

/** Return only people whose membership changed, preserving their other relationships. */
export function changedMemberships(
  persons: readonly Person[],
  field: 'tagIds' | 'keywordIds',
  entityId: string,
  selectedIds: readonly string[],
  modifiedAt = Date.now(),
): Person[] {
  const selected = new Set(selectedIds);
  return persons.flatMap(person => {
    const existing = person[field] ?? [];
    const shouldInclude = selected.has(person.id);
    if (existing.includes(entityId) === shouldInclude) return [];
    return [{ ...person, [field]: shouldInclude
      ? [...new Set([...existing, entityId])]
      : existing.filter(id => id !== entityId), modifiedAt }];
  });
}
