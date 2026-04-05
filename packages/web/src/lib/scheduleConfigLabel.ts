import type { ScheduleConfig } from '@labby/core';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function metadataTitle(config?: ScheduleConfig): string {
  if (!config) return '';
  const raw = config.metadata?.title;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getScheduleConfigSummary(config: ScheduleConfig): string {
  const days = config.daysOfWeek
    .map((day) => DAY_NAMES[day] ?? String(day))
    .join(', ');
  return `${config.startDate} -> ${config.endDate} | ${days || '-'} | ${config.timeRange[0]}-${config.timeRange[1]} | ${config.presentersPerSession}x${config.questionersPerPresenter}`;
}

export function getScheduleConfigLabel(config: ScheduleConfig): string {
  const title = metadataTitle(config);
  return title || getScheduleConfigSummary(config);
}

export function getScheduleConfigTitle(config?: ScheduleConfig): string {
  return metadataTitle(config);
}
