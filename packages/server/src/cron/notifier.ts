/**
 * Schedule notification service.
 *
 * Reads ScheduleConfigs that have a `notifyAt` cron expression in their
 * metadata, and registers cron jobs that send email notifications when
 * the scheduled time arrives.
 */

import { normalizeTimeZone, type ScheduleConfig } from '@labby/core';
import type { Mailer } from '../lib/mailer.js';
import type { CronScheduler } from './scheduler.js';
import type { LabbyStore } from '../store/index.js';
import { resolveScheduleTimezone } from '../lib/email-task-timezone.js';
import { safeErrorInfo } from '../lib/logging.js';

export interface ScheduleNotifierOptions {
  scheduler: CronScheduler;
  mailer: Mailer;
  store: LabbyStore;
  /** Email addresses to notify. */
  recipients: string[];
}

export class ScheduleNotifier {
  constructor(private readonly options: ScheduleNotifierOptions) {}

  /**
   * Synchronise cron jobs with the current set of configs.
   * Each config that has `metadata.notifyAt` (a cron expression) and
   * `metadata.notifyTimezone` (optional timezone string) will get a job.
   * Configs without `notifyAt` will have their jobs removed.
   */
  async syncJobs(): Promise<void> {
    const { scheduler, store } = this.options;
    const configs = await store.listConfigs();
    const systemSettings = await store.getSystemSettings();
    const activeNames = new Set<string>();

    for (const config of configs) {
      const notifyAt = config.notifyAt ?? (config.metadata?.['notifyAt'] as string | undefined);
      if (typeof notifyAt !== 'string' || !notifyAt.trim()) continue;

      const timezone = normalizeTimeZone(config.notifyTimezone)
        ?? (typeof config.metadata?.['notifyTimezone'] === 'string'
          ? normalizeTimeZone(config.metadata['notifyTimezone'])
          : undefined)
        ?? resolveScheduleTimezone(config, systemSettings);

      const jobName = `schedule-notify:${config.id}`;
      activeNames.add(jobName);

      try {
        scheduler.register({
          name: jobName,
          expression: notifyAt,
          timezone,
          handler: () => this.sendNotification(config, timezone),
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: 'notify_register_error', configId: config.id, ...safeErrorInfo(err) }));
      }
    }

    // Remove jobs for configs that no longer have notifyAt
    for (const existingJob of scheduler.registeredJobs) {
      if (existingJob.startsWith('schedule-notify:') && !activeNames.has(existingJob)) {
        scheduler.unregister(existingJob);
      }
    }
  }

  private async sendNotification(config: ScheduleConfig, timezone: string): Promise<void> {
    const { mailer, store, recipients } = this.options;
    if (recipients.length === 0) return;

    // Find the most recent schedule for this config (sort descending by createdAt)
    const schedules = (await store.listSchedules())
      .filter(s => s.configId === config.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = schedules[0];

    const subject = `[Labby] Schedule reminder – ${config.id}`;
    const sessionCount = latest?.sessions?.length ?? 0;
    const createdAtText = latest
      ? new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short',
      }).format(new Date(latest.createdAt))
      : '';
    const text = latest
      ? `Reminder: Schedule "${config.id}" has ${sessionCount} session(s). Latest plan created at ${createdAtText}.`
      : `Reminder: Schedule "${config.id}" has no plans generated yet.`;

    try {
      await mailer.send({ to: recipients, subject, text });
      console.info(JSON.stringify({ event: 'notify_sent', configId: config.id, recipientCount: recipients.length }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'notify_send_error', configId: config.id, ...safeErrorInfo(err) }));
    }
  }
}
