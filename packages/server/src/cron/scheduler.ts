/**
 * Cron job scheduler module.
 *
 * Provides a lightweight wrapper around node-cron that supports:
 *  - Named job registration / cancellation
 *  - Graceful shutdown
 *  - Independent from any application-layer concerns (can be reused for
 *    other purposes such as cleanup, reporting, etc.)
 */

import cron from 'node-cron';

export interface CronJobDefinition {
  /** Human-readable name, used for logging and deregistration. */
  name: string;
  /** Standard cron expression (5 or 6 fields). */
  expression: string;
  /** The function to run on each tick. Async functions are awaited. */
  handler: () => Promise<void> | void;
  /**
   * Timezone for the cron expression, e.g. "Asia/Tokyo".
   * Defaults to UTC if not specified.
   */
  timezone?: string;
}

export interface CronJobHandle {
  name: string;
  stop(): void;
}

export class CronScheduler {
  private readonly jobs = new Map<string, cron.ScheduledTask>();

  /**
   * Register and immediately start a cron job.
   * If a job with the same name already exists it is stopped and replaced.
   */
  register(definition: CronJobDefinition): CronJobHandle {
    this.unregister(definition.name);

    if (!cron.validate(definition.expression)) {
      throw new Error(`Invalid cron expression "${definition.expression}" for job "${definition.name}"`);
    }

    const task = cron.schedule(
      definition.expression,
      async () => {
        try {
          await definition.handler();
        } catch (err) {
          console.error(`[cron] Job "${definition.name}" failed:`, err);
        }
      },
      {
        timezone: definition.timezone ?? 'UTC',
        scheduled: true,
      },
    );

    this.jobs.set(definition.name, task);
    return {
      name: definition.name,
      stop: () => this.unregister(definition.name),
    };
  }

  /** Stop and remove a named cron job. */
  unregister(name: string): void {
    const existing = this.jobs.get(name);
    if (existing) {
      existing.stop();
      this.jobs.delete(name);
    }
  }

  /** Stop all registered cron jobs (call on graceful shutdown). */
  shutdown(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
      this.jobs.delete(name);
      console.info(`[cron] Stopped job "${name}"`);
    }
  }

  /** Returns the names of all currently registered jobs. */
  get registeredJobs(): string[] {
    return [...this.jobs.keys()];
  }
}

/** Singleton scheduler instance for the application. */
export const scheduler = new CronScheduler();
