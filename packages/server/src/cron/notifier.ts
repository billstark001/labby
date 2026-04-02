/**
 * Schedule notification service.
 *
 * Reads ScheduleConfigs that have a `notifyAt` cron expression in their
 * metadata, and registers cron jobs that send email notifications when
 * the scheduled time arrives.
 */

import type { ScheduleConfig } from '@labby/core';
import type { Mailer } from '../lib/mailer';
import type { CronScheduler } from './scheduler';
import type { SqliteStore } from '../store/index';

export interface ScheduleNotifierOptions {
  scheduler: CronScheduler;
  mailer: Mailer;
  store: SqliteStore;
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
    const activeNames = new Set<string>();

    for (const config of configs) {
      const notifyAt = config.notifyAt ?? (config.metadata?.['notifyAt'] as string | undefined);
      if (typeof notifyAt !== 'string' || !notifyAt.trim()) continue;

      const timezone = config.notifyTimezone
        ?? (typeof config.metadata?.['notifyTimezone'] === 'string'
          ? config.metadata['notifyTimezone'] as string
          : 'UTC');

      const jobName = `schedule-notify:${config.id}`;
      activeNames.add(jobName);

      try {
        scheduler.register({
          name: jobName,
          expression: notifyAt,
          timezone,
          handler: () => this.sendNotification(config),
        });
      } catch (err) {
        console.warn(`[notify] Could not register job for config ${config.id}:`, err);
      }
    }

    // Remove jobs for configs that no longer have notifyAt
    for (const existingJob of scheduler.registeredJobs) {
      if (existingJob.startsWith('schedule-notify:') && !activeNames.has(existingJob)) {
        scheduler.unregister(existingJob);
      }
    }
  }

  private async sendNotification(config: ScheduleConfig): Promise<void> {
    const { mailer, store, recipients } = this.options;
    if (recipients.length === 0) return;

    // Find the most recent schedule for this config (sort descending by createdAt)
    const schedules = (await store.listSchedules())
      .filter(s => s.configId === config.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    const latest = schedules[0];

    const subject = `[Labby] Schedule reminder – ${config.id}`;
    const sessionCount = latest?.sessions?.length ?? 0;
    const text = latest
      ? `Reminder: Schedule "${config.id}" has ${sessionCount} session(s). Latest plan created at ${new Date(latest.createdAt).toISOString()}.`
      : `Reminder: Schedule "${config.id}" has no plans generated yet.`;

    try {
      await mailer.send({ to: recipients, subject, text });
      console.info(`[notify] Sent reminder for config ${config.id} to ${recipients.join(', ')}`);
    } catch (err) {
      console.error(`[notify] Failed to send reminder for config ${config.id}:`, err);
    }
  }
}
