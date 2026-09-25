import type { ScheduleConstraint } from '../types.js';

/** The selector IDs referenced by a rule, regardless of how its groups pair. */
export function constraintSelectorIds(constraint: ScheduleConstraint): { personIds: string[]; tagIds: string[] } {
  const groups = constraint.type === 'frequency-multiplier'
    ? [{ personIds: constraint.personIds, tagIds: constraint.tagIds }]
    : constraint.groups;
  return {
    personIds: [...new Set(groups.flatMap(group => group.personIds))],
    tagIds: [...new Set(groups.flatMap(group => group.tagIds))],
  };
}
