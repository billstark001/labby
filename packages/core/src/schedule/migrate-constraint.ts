import type { ConstraintTargetGroup, ScheduleConstraint } from '../types.js';

/** Normalize constraints from database backups written before pair groups were unified. */
export function normalizeStoredConstraint(value: ScheduleConstraint): ScheduleConstraint {
  if (value.type === 'frequency-multiplier' || Array.isArray(value.groups)) return value;
  const legacy = value as ScheduleConstraint & {
    personIds?: string[];
    tagIds?: string[];
    otherPersonIds?: string[];
    otherTagIds?: string[];
    additionalGroups?: ConstraintTargetGroup[];
  };
  const {
    personIds = [], tagIds = [], otherPersonIds = [], otherTagIds = [], additionalGroups = [],
    ...rest
  } = legacy;
  const groups: ConstraintTargetGroup[] = [{ personIds, tagIds }];
  if (otherPersonIds.length || otherTagIds.length) groups.push({ personIds: otherPersonIds, tagIds: otherTagIds });
  groups.push(...additionalGroups);
  return { ...rest, groups } as ScheduleConstraint;
}
