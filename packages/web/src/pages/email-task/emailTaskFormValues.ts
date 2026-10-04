import {
  DEFAULT_TEMPLATE_PRESETS,
  EMAIL_TASK_TIMEZONE_SCHEDULE,
  EMAIL_TASK_TIMEZONE_SYSTEM,
  SYSTEM_DEFAULT_TIMEZONE,
  type EmailTask,
  type ScheduleDateGranularity,
  type ScheduleIcsMode,
  type TemplateFormat,
} from '@labby/core';
import type { EmailAttachmentType } from './AttachmentSettingsDialog';

export type InjectionLanguage = 'en' | 'zh-CN' | 'ja-JP';

export interface EmailTaskFormValues {
  configId: string;
  isDisabled: boolean;
  selectedDays: number[];
  sendTime: string;
  taskTimezone: string;
  emailsText: string;
  recentTimes: number;
  senderNameTemplate: string;
  subjectTemplate: string;
  templateText: string;
  templateFormat: TemplateFormat;
  injectionLanguage: InjectionLanguage;
  dateGranularity: ScheduleDateGranularity;
  notes: string;
  serveScheduleIcs: boolean;
  icsLinkMode: ScheduleIcsMode;
  icsContentTemplate: string;
  attachmentTypes: EmailAttachmentType[];
}

const DEFAULT_ATTACHMENT_TYPES: EmailAttachmentType[] = ['schedule-semester-csv', 'schedule-semester-ics'];

export function emptyEmailTaskFormValues(configId: string, language: InjectionLanguage): EmailTaskFormValues {
  return {
    configId,
    isDisabled: false,
    selectedDays: [1, 3, 5],
    sendTime: '09:00',
    taskTimezone: SYSTEM_DEFAULT_TIMEZONE,
    emailsText: '',
    recentTimes: 0,
    senderNameTemplate: '',
    subjectTemplate: '',
    templateText: DEFAULT_TEMPLATE_PRESETS[0]?.content ?? '',
    templateFormat: DEFAULT_TEMPLATE_PRESETS[0]?.format ?? 'markdown',
    injectionLanguage: language,
    dateGranularity: 'date',
    notes: '',
    serveScheduleIcs: false,
    icsLinkMode: 'presenters',
    icsContentTemplate: '',
    attachmentTypes: [...DEFAULT_ATTACHMENT_TYPES],
  };
}

export function emailTaskFormValuesFromTask(task: EmailTask, fallbackLanguage: InjectionLanguage): EmailTaskFormValues {
  const timezoneSource = task.metadata?.timezoneSource;
  const taskTimezone = timezoneSource === 'schedule'
    ? EMAIL_TASK_TIMEZONE_SCHEDULE
    : timezoneSource === 'system'
      ? EMAIL_TASK_TIMEZONE_SYSTEM
      : task.timezone ?? (typeof task.metadata?.timezone === 'string' ? task.metadata.timezone : SYSTEM_DEFAULT_TIMEZONE);
  const attachmentTypes = Array.isArray(task.metadata?.attachmentTypes)
    ? [...new Set(task.metadata.attachmentTypes.filter(
      (item): item is EmailAttachmentType => item === 'schedule-semester-csv' || item === 'schedule-semester-ics',
    ))]
    : [...DEFAULT_ATTACHMENT_TYPES];

  return {
    configId: task.configId,
    isDisabled: task.disabled ?? false,
    selectedDays: task.daysOfWeek,
    sendTime: task.sendTime ?? '09:00',
    taskTimezone,
    emailsText: task.emails.join(', '),
    recentTimes: task.recentTimes,
    senderNameTemplate: task.senderNameTemplate ?? '',
    subjectTemplate: task.subjectTemplate ?? '',
    templateText: task.templateText,
    templateFormat: (task.metadata?.format as TemplateFormat | undefined) ?? 'markdown',
    injectionLanguage: (task.metadata?.injectionLanguage as InjectionLanguage | undefined) ?? fallbackLanguage,
    dateGranularity: (task.metadata?.dateGranularity as ScheduleDateGranularity | undefined) ?? 'date',
    notes: task.notes ?? '',
    serveScheduleIcs: (task.metadata?.serveScheduleIcs as boolean | undefined) ?? false,
    icsLinkMode: task.metadata?.icsLinkMode === 'meeting' ? 'meeting' : 'presenters',
    icsContentTemplate: typeof task.metadata?.icsContentTemplate === 'string' ? task.metadata.icsContentTemplate : '',
    attachmentTypes,
  };
}
