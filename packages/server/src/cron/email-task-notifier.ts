import type { EmailTask, ScheduleConfig } from '@labby/core';
import { buildEmailTemplateScheduleVariables, renderTemplate, renderTemplateToHtml, type ScheduleDateGranularity } from '@labby/core';

import type { Mailer } from '../lib/mailer.js';
import type { CronScheduler } from './scheduler.js';
import type { SqliteStore } from '../store/index.js';

export interface EmailTaskNotifierOptions {
  scheduler: CronScheduler;
  mailer: Mailer;
  store: SqliteStore;
  defaultHour?: number;
  enablePublicEmailTaskIcs?: boolean;
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

function resolveTaskTimezone(task: EmailTask): string {
  return (
    task.timezone
    ?? (typeof task.metadata?.timezone === 'string' ? task.metadata.timezone : undefined)
    ?? 'UTC'
  );
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
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(runAt));
}

function latestScheduleSummary(sessions: number, createdAt: number | null): string {
  if (!createdAt) return `No generated schedule found. Session count: ${sessions}.`;
  return `Latest plan has ${sessions} sessions, created at ${new Date(createdAt).toISOString()}.`;
}

export class EmailTaskNotifier {
  constructor(private readonly options: EmailTaskNotifierOptions) {}

  private buildTaskIcsUrl(task: EmailTask): string | undefined {
    if (!this.options.enablePublicEmailTaskIcs) return undefined;
    const shouldServeIcs = Boolean(task.metadata && (task.metadata as Record<string, unknown>).serveScheduleIcs === true);
    if (!shouldServeIcs) return undefined;
    const base = this.options.publicBaseUrl?.trim();
    if (!base) return undefined;
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}/public/email-tasks/${encodeURIComponent(task.id)}/schedule.ics`;
  }

  async syncJobs(): Promise<void> {
    const { scheduler, store } = this.options;
    const tasks = await store.listEmailTasks();
    const active = new Set<string>();

    for (const task of tasks) {
      const days = uniqueSortedDays(task.daysOfWeek);
      if (days.length === 0 || task.emails.length === 0) continue;

      const jobName = `email-task:${task.id}`;
      active.add(jobName);

      const sendTime = parseSendTime(task.sendTime ?? (task.metadata?.sendTime as string | undefined), this.options.defaultHour ?? 9);
      const expression = toCronExpression(days, sendTime.hour, sendTime.minute);
      const timezone = resolveTaskTimezone(task);

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

  async runTaskNow(taskId: string): Promise<void> {
    const task = await this.options.store.getEmailTask(taskId);
    if (!task) return;
    await this.executeTask(task, { manual: true });
  }

  private async executeTask(task: EmailTask, options: { manual: boolean }): Promise<void> {
    const config = await this.options.store.getConfig(task.configId);
    if (!config) return;
    const persons = await this.options.store.listPersons();

    const latest = (await this.options.store.listSchedules())
      .filter((item) => item.configId === task.configId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    const sentCounts = { ...(task.sentCounts ?? {}) };
    const runAt = Date.now();

    if (!options.manual && task.skipNextRun) {
      await this.options.store.putEmailTask({
        ...task,
        skipNextRun: false,
        lastSkippedAt: runAt,
        modifiedAt: runAt,
      });
      return;
    }

    for (const recipient of task.emails) {
      const currentSent = sentCounts[recipient] ?? 0;
      if (task.recentTimes > 0 && currentSent >= task.recentTimes) {
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
      );
      const rendered = renderTemplateToHtml(task.templateText, context, {
        format: (task.metadata?.format as 'markdown' | 'html' | undefined) ?? 'markdown',
      });
      if (rendered.errors.length > 0) {
        console.warn(`[email-task] template render errors for task ${task.id}:`, rendered.errors);
        continue;
      }

      const renderedSubject = task.subjectTemplate
        ? renderTemplate(task.subjectTemplate, context)
        : { output: '', errors: [] };
      if (renderedSubject.errors.length > 0) {
        console.warn(`[email-task] subject template render errors for task ${task.id}:`, renderedSubject.errors);
      }

      await this.options.mailer.send({
        to: [recipient],
        subject: renderedSubject.output.trim() || `[Labby] Scheduled Email ${task.id}`,
        text: rendered.output,
        html: rendered.html,
      });

      sentCounts[recipient] = currentSent + 1;
    }

    await this.options.store.putEmailTask({
      ...task,
      sentCounts,
      lastRunAt: runAt,
      modifiedAt: runAt,
    });
  }

  private buildTemplateContext(
    task: EmailTask,
    config: ScheduleConfig,
    recipient: string,
    sessionCount: number,
    latestCreatedAt: number | null,
    runAt: number,
    persons: Awaited<ReturnType<SqliteStore['listPersons']>>,
    latestPlan: Awaited<ReturnType<SqliteStore['listSchedules']>>[number] | undefined,
  ): Record<string, unknown> {
    const locale = (task.metadata?.dateLocale as string | undefined)
      ?? (task.metadata?.injectionLanguage as string | undefined)
      ?? 'en';
    const granularity = (task.metadata?.dateGranularity as ScheduleDateGranularity | undefined) ?? 'date';
    const timeZone = resolveTaskTimezone(task);
    const anchorDate = formatZonedDate(runAt, timeZone);

    const scheduleVariables = buildEmailTemplateScheduleVariables({
      plan: latestPlan,
      persons,
      config,
      locale,
      granularity,
      anchorDate,
    });
    const scheduleIcsUrl = this.buildTaskIcsUrl(task);
    const nowIsoUtc = new Date(runAt).toISOString();
    const nowLocal = formatZonedDateTime(runAt, locale, timeZone);

    return {
      taskId: task.id,
      configId: config.id,
      recipient,
      now: nowIsoUtc,
      nowIsoUtc,
      nowLocal,
      runTimezone: timeZone,
      anchorDate,
      sessionCount,
      latestCreatedAt,
      summary: latestScheduleSummary(sessionCount, latestCreatedAt),
      language: (task.metadata?.injectionLanguage as string | undefined) ?? 'en',
      scheduleIcsUrl,
      ...scheduleVariables,
    };
  }
}
