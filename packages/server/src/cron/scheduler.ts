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
import type { ScheduledTask } from 'node-cron';
import { safeErrorInfo } from '../lib/logging.js';

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

export type StaticSchedulerMode = 'cron' | 'cloud' | 'external';
export type DynamicSchedulerMode = 'cron' | 'cloud';

export interface SchedulerMirror {
  sync(definitions: CronJobDefinition[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface CronJobHandle {
  name: string;
  stop(): void;
}

/** The application services only need this contract, regardless of who ticks jobs. */
export interface JobScheduler {
  register(definition: CronJobDefinition): CronJobHandle;
  unregister(name: string): void;
  readonly registeredJobs: string[];
  runNow(name: string): Promise<boolean>;
  sync(): Promise<void>;
}

export class CronScheduler implements JobScheduler {
  private readonly jobs = new Map<string, ScheduledTask>();
  private readonly definitions = new Map<string, CronJobDefinition>();
  private readonly running = new Set<string>();
  private mode: StaticSchedulerMode = 'cron';
  private mirror: SchedulerMirror | null = null;
  private pendingSync: Promise<void> = Promise.resolve();

  setMode(mode: StaticSchedulerMode): void {
    this.mode = mode;
  }

  setMirror(mirror: SchedulerMirror | null): void {
    this.mirror = mirror;
  }

  getMode(): StaticSchedulerMode {
    return this.mode;
  }

  get hasMirror(): boolean {
    return this.mirror !== null;
  }

  private async execute(name: string, handler: CronJobDefinition['handler']): Promise<void> {
    if (this.running.has(name)) {
      console.warn(JSON.stringify({ event: 'scheduler_job_overlap_skipped', job: name }));
      return;
    }
    this.running.add(name);
    try {
      await handler();
    } finally {
      this.running.delete(name);
    }
  }

  /**
   * Register and immediately start a cron job.
   * If a job with the same name already exists it is stopped and replaced.
   */
  register(definition: CronJobDefinition): CronJobHandle {
    if (!cron.validate(definition.expression)) {
      throw new Error(`Invalid cron expression "${definition.expression}" for job "${definition.name}"`);
    }

    const existing = this.jobs.get(definition.name);
    if (existing) {
      existing.stop();
      this.jobs.delete(definition.name);
    }

    this.definitions.set(definition.name, definition);

    if (this.mode === 'cron') {
      const task = cron.schedule(
        definition.expression,
        async () => {
          try {
            await this.execute(definition.name, definition.handler);
          } catch (err) {
            console.error(JSON.stringify({ event: 'cron_job_error', job: definition.name, ...safeErrorInfo(err) }));
          }
        },
        {
          timezone: definition.timezone ?? 'UTC',
        },
      );

      this.jobs.set(definition.name, task);
    }

    return {
      name: definition.name,
      stop: () => {
        if (this.definitions.get(definition.name) === definition) this.unregister(definition.name);
      },
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
        console.error(JSON.stringify({ event: 'scheduler_mirror_shutdown_error', ...safeErrorInfo(err) }));
      });
    }
  }

  /** Returns the names of all currently registered jobs. */
  get registeredJobs(): string[] {
    return [...this.definitions.keys()];
  }

  async sync(): Promise<void> {
    if (!this.mirror) return;
    // Serialize reconciliations. Read the current definitions when the queued
    // operation starts so a stale callback cannot restore an older schedule.
    const next = this.pendingSync.catch(() => {}).then(() => this.mirror!.sync([...this.definitions.values()]));
    this.pendingSync = next;
    await next;
  }

  async runNow(name: string): Promise<boolean> {
    const definition = this.definitions.get(name);
    if (!definition) return false;

    await this.execute(name, definition.handler);
    return true;
  }
}

function resolveMode(value: string | undefined, variable: string): StaticSchedulerMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'cron') return 'cron';
  if (normalized === 'cloud') return 'cloud';
  if (normalized === 'external') return 'external';
  throw new Error(`Unsupported ${variable}: ${value}`);
}

export function resolveStaticSchedulerMode(value: string | undefined): StaticSchedulerMode {
  return resolveMode(value, 'STATIC_SCHEDULER_MODE');
}

export function resolveDynamicSchedulerMode(value: string | undefined): DynamicSchedulerMode {
  const mode = resolveMode(value, 'DYNAMIC_SCHEDULER_MODE');
  if (mode === 'external') throw new Error('DYNAMIC_SCHEDULER_MODE cannot be external');
  return mode;
}
