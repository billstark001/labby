import { createHash } from 'node:crypto';

export function dispatchOccurrenceId(input: {
  cloudJobName?: string;
  cloudScheduleTime?: string;
  railwayDispatchId?: string;
}): string | undefined {
  const cloudJobName = input.cloudJobName?.trim();
  const cloudScheduleTime = input.cloudScheduleTime?.trim();
  if (cloudJobName && cloudScheduleTime && cloudJobName.length <= 600
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(cloudScheduleTime)) {
    return createHash('sha256').update(`cloud\0${cloudJobName}\0${cloudScheduleTime}`).digest('hex');
  }
  const railwayDispatchId = input.railwayDispatchId?.trim();
  if (railwayDispatchId && /^[0-9a-fA-F-]{36}$/.test(railwayDispatchId)) {
    return createHash('sha256').update(`railway\0${railwayDispatchId}`).digest('hex');
  }
  return undefined;
}
