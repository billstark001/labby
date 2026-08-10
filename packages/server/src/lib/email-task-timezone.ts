import type { EmailTask, ScheduleConfig, SystemSettings } from '@labby/core';
import { getEnvironmentTimeZone, normalizeTimeZone } from '@labby/core';

export type EmailTaskTimezoneSource = 'default' | 'schedule' | 'system' | 'task';

function metadataTimezoneSource(task: EmailTask): EmailTaskTimezoneSource {
  const value = task.metadata?.timezoneSource;
  if (value === 'schedule' || value === 'system' || value === 'task') return value;
  return 'default';
}

export function resolveSystemTimezone(settings?: SystemSettings): string {
  return normalizeTimeZone(settings?.timezone) ?? getEnvironmentTimeZone();
}

export function resolveScheduleTimezone(
  config: ScheduleConfig | undefined,
  settings?: SystemSettings,
): string {
  return normalizeTimeZone(config?.timezone) ?? resolveSystemTimezone(settings);
}

export function resolveEmailTaskTimezone(
  task: EmailTask,
  config: ScheduleConfig | undefined,
  settings?: SystemSettings,
): string {
  const source = metadataTimezoneSource(task);
  if (source === 'system') return resolveSystemTimezone(settings);
  if (source === 'schedule') return resolveScheduleTimezone(config, settings);

  const explicit = normalizeTimeZone(task.timezone)
    ?? (typeof task.metadata?.timezone === 'string' ? normalizeTimeZone(task.metadata.timezone) : undefined);

  if (source === 'task') {
    return explicit ?? resolveScheduleTimezone(config, settings);
  }

  return explicit ?? resolveScheduleTimezone(config, settings);
}
