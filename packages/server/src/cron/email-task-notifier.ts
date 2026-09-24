import type { EmailTask, ScheduleConfig } from '@labby/core';
import {
  buildEmailTemplateScheduleVariables,
  buildScheduleIcs,
  buildScheduleTemplateBlocks,
  renderTemplate,
  renderTemplateToHtml,
  type Person,
  type ScheduleDateGranularity,
  type SchedulePlan,
} from '@labby/core';

import type { Mailer } from '../lib/mailer.js';
import type { CronScheduler } from './scheduler.js';
import type { LabbyStore } from '../store/index.js';
import { resolveEmailTaskTimezone, resolveScheduleTimezone } from '../lib/email-task-timezone.js';

export interface EmailTaskNotifierOptions {
  scheduler: CronScheduler;
  mailer: Mailer;
  store: LabbyStore;
  defaultHour?: number;
  publicBaseUrl?: string;
}

function uniqueSortedDays(days: number[]): number[] {
  return [...new Set(days.filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function parseSendTime(sendTime: string | undefined, fallbackHour: number): { hour: number; minute: number } {
  const text = (sendTime ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return {
      hour: Math.max(0, Math.min(23, fallbackHour)),
      minute: 0,
    };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return {
      hour: Math.max(0, Math.min(23, fallbackHour)),
      minute: 0,
    };
  }

  return { hour, minute };
}

function toCronExpression(days: number[], hour: number, minute: number): string {
  const normalizedDays = uniqueSortedDays(days);
  const dow = normalizedDays.join(',');
  const clampedHour = Math.max(0, Math.min(23, hour));
  const clampedMinute = Math.max(0, Math.min(59, minute));
  return `${clampedMinute} ${clampedHour} * * ${dow}`;
}

function formatZonedDate(runAt: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(runAt));
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function formatZonedDateTime(runAt: number, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(runAt));
}

function personDisplayName(person: Person, locale: string): string {
  return person.names?.[locale] ?? person.names?.en ?? person.name ?? person.id;
}

type EmailAttachmentType = 'schedule-semester-csv' | 'schedule-semester-ics';

function resolveAttachmentTypes(task: EmailTask): EmailAttachmentType[] {
  const value = task.metadata?.attachmentTypes;
  if (!Array.isArray(value)) {
    return ['schedule-semester-csv', 'schedule-semester-ics'];
  }

  const types = value
    .filter((item): item is string => typeof item === 'string')
    .filter((item): item is EmailAttachmentType => item === 'schedule-semester-csv' || item === 'schedule-semester-ics');
  return [...new Set(types)];
}

function icsLabelsForLocale(locale: string): { presenter: string; questioners: string } {
  if (locale === 'zh-CN') {
    return { presenter: '主讲', questioners: '提问' };
  }
  if (locale === 'ja-JP') {
    return { presenter: '発表者', questioners: '質問者' };
  }
  return { presenter: 'Presenter', questioners: 'Questioners' };
}

function buildScheduleAttachments(input: {
  task: EmailTask;
  config: ScheduleConfig;
  plan: SchedulePlan;
  locale: string;
  persons: Person[];
  timezone: string;
}): Array<{ filename: string; content: Buffer; contentType: string }> {
  const selectedTypes = resolveAttachmentTypes(input.task);
  if (selectedTypes.length === 0) {
    return [];
  }

  const personMap = new Map(input.persons.map((person) => [person.id, person]));
  const displayName = (person: Person) => personDisplayName(person, input.locale);
  const localeTag = input.locale.replace(/[^a-z0-9-]/gi, '') || 'en';
  const blocks = selectedTypes.includes('schedule-semester-csv')
    ? buildScheduleTemplateBlocks(input.plan, personMap, displayName, {
      config: input.config,
      dateDisplay: {
        locale: input.locale,
        granularity: 'date',
        includeWeekday: true,
        timeZone: input.timezone,
      },
    })
    : null;
  const ics = selectedTypes.includes('schedule-semester-ics')
    ? buildScheduleIcs(input.plan, personMap, displayName, input.config, icsLabelsForLocale(input.locale), {
      timeZone: input.timezone,
    })
    : null;
  const slug = input.config.id.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'schedule';
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (blocks) {
    attachments.push({
      filename: `schedule-${slug}-semester.${localeTag}.csv`,
      content: Buffer.from(blocks.csv, 'utf-8'),
      contentType: 'text/csv; charset=utf-8',
    });
  }
  if (ics) {
    attachments.push({
      filename: `schedule-${slug}-semester.${localeTag}.ics`,
      content: Buffer.from(ics, 'utf-8'),
      contentType: 'text/calendar; charset=utf-8',
    });
  }
  return attachments;
}

function hasPeriodEnded(config: ScheduleConfig, runAt: number, timezone: string, latest?: SchedulePlan): boolean {
  const today = formatZonedDate(runAt, timezone);
  const lastMeeting = latest?.sessions.reduce((last, session) => session.date > last ? session.date : last, config.endDate) ?? config.endDate;
  return today > lastMeeting;
}

function latestScheduleSummary(sessions: number, createdAt: number | null, locale: string, timezone: string): string {
  if (!createdAt) return `No generated schedule found. Session count: ${sessions}.`;
  return `Latest plan has ${sessions} sessions, created at ${formatZonedDateTime(createdAt, locale, timezone)}.`;
}

type TaskExecutionContext = {
  config: ScheduleConfig | undefined;
  persons: Person[];
  latest: SchedulePlan | undefined;
  sentCounts: Record<string, number>;
  runAt: number;
  timezone: string;
  scheduleTimezone: string;
};

type TaskExecutionDecision =
  | { kind: 'unregister-missing-config' }
  | { kind: 'skip-disabled' }
  | { kind: 'skip-ended' }
  | { kind: 'skip-next' }
  | { kind: 'skip-no-schedule' }
  | { kind: 'send' };

interface TaskDeliveryFailure {
  kind: 'render' | 'send';
}

export interface ManualEmailResult {
  sent: number;
  failed: number;
}

export class EmailTaskNotifier {
  constructor(private readonly options: EmailTaskNotifierOptions) {}

  private buildTaskIcsUrl(task: EmailTask): string | undefined {
    const shouldServeIcs = Boolean(task.metadata && (task.metadata as Record<string, unknown>).serveScheduleIcs === true);
    if (!shouldServeIcs) return undefined;
    const base = this.options.publicBaseUrl?.trim();
    if (!base) return undefined;
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}/public/email-tasks/${encodeURIComponent(task.id)}/schedule.ics`;
  }

  private async loadExecutionContext(task: EmailTask): Promise<TaskExecutionContext> {
    const config = await this.options.store.getConfig(task.configId);
    const systemSettings = await this.options.store.getSystemSettings();
    const persons = config ? await this.options.store.listPersons() : [];
    const latest = config
      ? (await this.options.store.listSchedules())
        .filter((item) => item.configId === task.configId)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      : undefined;

    return {
      config,
      persons,
      latest,
      sentCounts: { ...(task.sentCounts ?? {}) },
      runAt: Date.now(),
      timezone: resolveEmailTaskTimezone(task, config, systemSettings),
      scheduleTimezone: resolveScheduleTimezone(config, systemSettings),
    };
  }

  private determineExecutionDecision(task: EmailTask, context: TaskExecutionContext, options: { manual: boolean }): TaskExecutionDecision {
    if (!context.config) {
      return { kind: 'unregister-missing-config' };
    }

    if (!options.manual && task.disabled) {
      return { kind: 'skip-disabled' };
    }

    if (!options.manual && hasPeriodEnded(context.config, context.runAt, context.scheduleTimezone, context.latest)) {
      return { kind: 'skip-ended' };
    }

    if (!options.manual && task.skipNextRun) {
      return { kind: 'skip-next' };
    }

    if (!context.latest) {
      return { kind: 'skip-no-schedule' };
    }

    return { kind: 'send' };
  }

  private async persistTask(task: EmailTask, patch: Partial<EmailTask>): Promise<void> {
    await this.options.store.putEmailTask({
      ...task,
      ...patch,
      modifiedAt: patch.modifiedAt ?? Date.now(),
    });
  }

  private async persistScheduledSkip(task: EmailTask, runAt: number, patch: Partial<EmailTask> = {}): Promise<void> {
    await this.persistTask(task, {
      ...patch,
      lastSkippedAt: runAt,
      modifiedAt: runAt,
    });
  }

  async syncJobs(): Promise<void> {
    const { scheduler, store } = this.options;
    const tasks = await store.listEmailTasks();
    const configs = new Map((await store.listConfigs()).map((config) => [config.id, config]));
    const systemSettings = await store.getSystemSettings();
    const runAt = Date.now();
    const endedConfigs = new Set(tasks.filter(task => !task.disabled && task.emails.length > 0 && task.daysOfWeek.length > 0)
      .map(task => configs.get(task.configId))
      .filter((config): config is ScheduleConfig => config !== undefined
        && formatZonedDate(runAt, resolveScheduleTimezone(config, systemSettings)) > config.endDate)
      .map(config => config.id));
    const latestSchedules = new Map<string, SchedulePlan>();
    if (endedConfigs.size > 0) {
      for (const plan of await store.listSchedules()) {
        if (!endedConfigs.has(plan.configId)) continue;
        const previous = latestSchedules.get(plan.configId);
        if (!previous || plan.createdAt > previous.createdAt) latestSchedules.set(plan.configId, plan);
      }
    }
    const active = new Set<string>();

    for (const task of tasks) {
      if (task.disabled) continue;

      const days = uniqueSortedDays(task.daysOfWeek);
      if (days.length === 0 || task.emails.length === 0) continue;

      const config = configs.get(task.configId);
      if (!config) continue;

      const timezone = resolveEmailTaskTimezone(task, config, systemSettings);
      if (hasPeriodEnded(config, runAt, resolveScheduleTimezone(config, systemSettings), latestSchedules.get(config.id))) continue;

      const jobName = `email-task:${task.id}`;
      active.add(jobName);

      const sendTime = parseSendTime(task.sendTime ?? (task.metadata?.sendTime as string | undefined), this.options.defaultHour ?? 9);
      const expression = toCronExpression(days, sendTime.hour, sendTime.minute);

      scheduler.register({
        name: jobName,
        expression,
        timezone,
        handler: async () => {
          await this.runTask(task.id);
        },
      });
    }

    for (const existingJob of scheduler.registeredJobs) {
      if (existingJob.startsWith('email-task:') && !active.has(existingJob)) {
        scheduler.unregister(existingJob);
      }
    }
  }

  async runTask(taskId: string): Promise<void> {
    const task = await this.options.store.getEmailTask(taskId);
    if (!task) return;
    await this.executeTask(task, { manual: false });
  }

  async runTaskNow(taskId: string, recipients: string[]): Promise<ManualEmailResult> {
    const task = await this.options.store.getEmailTask(taskId);
    if (!task) throw new Error('Email task not found');
    return this.executeTask(task, { manual: true, recipients });
  }

  private async executeTask(task: EmailTask, options: { manual: boolean; recipients?: string[] }): Promise<ManualEmailResult> {
    const context = await this.loadExecutionContext(task);
    const decision = this.determineExecutionDecision(task, context, options);

    if (decision.kind === 'unregister-missing-config') {
      if (options.manual) throw new Error('Email task has no schedule configuration');
      this.options.scheduler.unregister(`email-task:${task.id}`);
      return { sent: 0, failed: 0 };
    }

    const { config, persons, latest, sentCounts, runAt, timezone, scheduleTimezone } = context;

    if (decision.kind === 'skip-disabled') {
      await this.persistScheduledSkip(task, runAt);
      return { sent: 0, failed: 0 };
    }

    if (decision.kind === 'skip-ended') {
      this.options.scheduler.unregister(`email-task:${task.id}`);
      await this.persistScheduledSkip(task, runAt);
      return { sent: 0, failed: 0 };
    }

    if (decision.kind === 'skip-next') {
      await this.persistScheduledSkip(task, runAt, {
        skipNextRun: false,
      });
      return { sent: 0, failed: 0 };
    }

    if (decision.kind === 'skip-no-schedule') {
      if (options.manual) throw new Error('No generated schedule is available');
      if (!options.manual) {
        await this.persistScheduledSkip(task, runAt);
      }
      return { sent: 0, failed: 0 };
    }

    if (!config || !latest) {
      throw new Error('Email task is missing its schedule');
    }

    const locale = (task.metadata?.dateLocale as string | undefined)
      ?? (task.metadata?.injectionLanguage as string | undefined)
      ?? 'en';
    const attachments = buildScheduleAttachments({
      task,
      config,
      plan: latest,
      locale,
      persons,
      timezone: scheduleTimezone,
    });

    const failures: TaskDeliveryFailure[] = [];
    let sentAny = false;

    let sent = 0;
    for (const recipient of options.recipients ?? task.emails) {
      const currentSent = sentCounts[recipient] ?? 0;
      if (!options.manual && task.recentTimes > 0 && currentSent >= task.recentTimes) {
        continue;
      }

      const context = this.buildTemplateContext(
        task,
        config,
        recipient,
        latest?.sessions.length ?? 0,
        latest?.createdAt ?? null,
        runAt,
        persons,
        latest,
        timezone,
        scheduleTimezone,
      );
      const rendered = renderTemplateToHtml(task.templateText, context, {
        format: (task.metadata?.format as 'markdown' | 'html' | undefined) ?? 'markdown',
      });
      if (rendered.errors.length > 0) {
        console.warn(JSON.stringify({ event: 'email_template_error', taskId: task.id, part: 'body', count: rendered.errors.length }));
        failures.push({ kind: 'render' });
        continue;
      }

      const renderedSubject = task.subjectTemplate
        ? renderTemplate(task.subjectTemplate, context)
        : { output: '', errors: [] };
      if (renderedSubject.errors.length > 0) {
        console.warn(JSON.stringify({ event: 'email_template_error', taskId: task.id, part: 'subject', count: renderedSubject.errors.length }));
        failures.push({ kind: 'render' });
        continue;
      }

      const renderedSenderName = task.senderNameTemplate
        ? renderTemplate(task.senderNameTemplate, context)
        : { output: '', errors: [] };
      if (renderedSenderName.errors.length > 0) {
        console.warn(JSON.stringify({ event: 'email_template_error', taskId: task.id, part: 'sender', count: renderedSenderName.errors.length }));
        failures.push({ kind: 'render' });
        continue;
      }

      try {
        await this.options.mailer.send({
          to: [recipient],
          subject: renderedSubject.output.trim() || `[Labby] Scheduled Email ${task.id}`,
          fromName: renderedSenderName.output.trim() || undefined,
          text: rendered.output,
          html: rendered.html,
          attachments,
        });
      } catch {
        failures.push({ kind: 'send' });
        continue;
      }

      if (!options.manual) sentCounts[recipient] = currentSent + 1;
      sentAny = true;
      sent++;
    }

    if (!options.manual && (sentAny || failures.length === 0)) {
      await this.persistTask(task, {
        sentCounts,
        lastRunAt: runAt,
      });
    }

    if (options.manual) {
      if (sent === 0) throw new Error(failures.length > 0 ? `Email delivery failed for ${failures.length} recipient(s)` : 'No recipients were sent an email');
      return { sent, failed: failures.length };
    }

    if (failures.length > 0) {
      throw new Error(`Email task ${task.id} failed for ${failures.length} recipient(s)`);
    }
    return { sent, failed: 0 };
  }

  private buildTemplateContext(
    task: EmailTask,
    config: ScheduleConfig,
    recipient: string,
    sessionCount: number,
    latestCreatedAt: number | null,
    runAt: number,
    persons: Awaited<ReturnType<LabbyStore['listPersons']>>,
    latestPlan: Awaited<ReturnType<LabbyStore['listSchedules']>>[number] | undefined,
    timeZone: string,
    scheduleTimeZone: string,
  ): Record<string, unknown> {
    const locale = (task.metadata?.dateLocale as string | undefined)
      ?? (task.metadata?.injectionLanguage as string | undefined)
      ?? 'en';
    const granularity = (task.metadata?.dateGranularity as ScheduleDateGranularity | undefined) ?? 'date';
    const anchorDate = formatZonedDate(runAt, scheduleTimeZone);

    const scheduleVariables = buildEmailTemplateScheduleVariables({
      plan: latestPlan,
      persons,
      config,
      locale,
      granularity,
      anchorDate,
      timeZone: scheduleTimeZone,
    });
    const scheduleIcsUrl = this.buildTaskIcsUrl(task);
    const nowIsoUtc = new Date(runAt).toISOString();
    const nowLocal = formatZonedDateTime(runAt, locale, timeZone);

    return {
      taskId: task.id,
      configId: config.id,
      recipient,
      now: nowLocal,
      nowIsoUtc,
      nowLocal,
      runTimezone: timeZone,
      anchorDate,
      sessionCount,
      latestCreatedAt,
      summary: latestScheduleSummary(sessionCount, latestCreatedAt, locale, timeZone),
      language: (task.metadata?.injectionLanguage as string | undefined) ?? 'en',
      scheduleIcsUrl,
      ...scheduleVariables,
    };
  }
}
