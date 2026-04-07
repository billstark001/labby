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

export type SchedulerMode = 'cron' | 'cloud' | 'hybrid';

export interface SchedulerMirror {
  upsert(definition: CronJobDefinition): Promise<void>;
  remove(name: string): Promise<void>;
  sync(definitions: CronJobDefinition[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface CronJobHandle {
  name: string;
  stop(): void;
}

export class CronScheduler {
  private readonly jobs = new Map<string, cron.ScheduledTask>();
  private readonly definitions = new Map<string, CronJobDefinition>();
  private mode: SchedulerMode = 'cron';
  private mirror: SchedulerMirror | null = null;

  setMode(mode: SchedulerMode): void {
    this.mode = mode;
  }

  setMirror(mirror: SchedulerMirror | null): void {
    this.mirror = mirror;
  }

  getMode(): SchedulerMode {
    return this.mode;
  }

  get hasMirror(): boolean {
    return this.mirror !== null;
  }

  private shouldRunLocally(): boolean {
    return this.mode === 'cron' || this.mode === 'hybrid';
  }

  private upsertMirror(definition: CronJobDefinition): void {
    if (!this.mirror) return;
    void this.mirror.upsert(definition).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed to upsert mirrored job "${definition.name}": ${message}`);
    });
  }

  private removeMirror(name: string): void {
    if (!this.mirror) return;
    void this.mirror.remove(name).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed to remove mirrored job "${name}": ${message}`);
    });
  }

  /**
   * Register and immediately start a cron job.
   * If a job with the same name already exists it is stopped and replaced.
   */
  register(definition: CronJobDefinition): CronJobHandle {
    this.unregister(definition.name);

    if (!cron.validate(definition.expression)) {
      throw new Error(`Invalid cron expression "${definition.expression}" for job "${definition.name}"`);
    }

    this.definitions.set(definition.name, definition);

    if (this.shouldRunLocally()) {
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
    }

    this.upsertMirror(definition);
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
    this.definitions.delete(name);
    this.removeMirror(name);
  }

  /** Stop all registered cron jobs (call on graceful shutdown). */
  shutdown(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
      this.jobs.delete(name);
      console.info(`[cron] Stopped job "${name}"`);
    }
    this.definitions.clear();

    if (this.mirror?.shutdown) {
      void this.mirror.shutdown().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Failed to shutdown mirror: ${message}`);
      });
    }
  }

  /** Returns the names of all currently registered jobs. */
  get registeredJobs(): string[] {
    return [...this.definitions.keys()];
  }

  async syncMirrorNow(): Promise<void> {
    if (!this.mirror) return;
    await this.mirror.sync([...this.definitions.values()]);
  }

  async runNow(name: string): Promise<boolean> {
    const definition = this.definitions.get(name);
    if (!definition) return false;

    await definition.handler();
    return true;
  }
}

export function resolveSchedulerMode(value: string | undefined): SchedulerMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'cloud') return 'cloud';
  if (normalized === 'hybrid' || normalized === 'both') return 'hybrid';
  return 'cron';
}

/** Singleton scheduler instance for the application. */
export const scheduler = new CronScheduler();
