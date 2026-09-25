import { createCloudSchedulerMirrorFromEnv } from './cloud-scheduler.js';
import {
  CronScheduler,
  resolveDynamicSchedulerMode,
  resolveStaticSchedulerMode,
  type DynamicSchedulerMode,
  type JobScheduler,
  type StaticSchedulerMode,
} from './scheduler.js';
import { safeErrorInfo } from '../lib/logging.js';

export interface SchedulerRuntime {
  readonly staticMode: StaticSchedulerMode;
  readonly dynamicMode: DynamicSchedulerMode;
  readonly staticJobs: JobScheduler;
  readonly dynamicJobs: JobScheduler;
  runNow(name: string): Promise<boolean>;
  sync(): Promise<void>;
  shutdown(): void;
}

/** Fixed jobs may use Railway Cron; database-defined jobs need a dynamic provider. */
export function createSchedulerRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerRuntime {
  if (env.NODE_ENV === 'production' && (!env.STATIC_SCHEDULER_MODE?.trim() || !env.DYNAMIC_SCHEDULER_MODE?.trim())) {
    throw new Error('Production requires STATIC_SCHEDULER_MODE and DYNAMIC_SCHEDULER_MODE');
  }
  const staticMode = resolveStaticSchedulerMode(env.STATIC_SCHEDULER_MODE);
  const dynamicMode = resolveDynamicSchedulerMode(env.DYNAMIC_SCHEDULER_MODE);
  const dynamicJobs = new CronScheduler();
  const staticJobs = staticMode === dynamicMode ? dynamicJobs : new CronScheduler();

  staticJobs.setMode(staticMode);
  dynamicJobs.setMode(dynamicMode);

  if (staticMode !== 'cron' || dynamicMode !== 'cron') {
    if (!env.SCHEDULER_DISPATCH_API_KEY?.trim()) {
      throw new Error('External schedulers require SCHEDULER_DISPATCH_API_KEY');
    }
  }
  if (staticMode === 'cloud' || dynamicMode === 'cloud') {
    const mirror = createCloudSchedulerMirrorFromEnv(env);
    if (!mirror) {
      throw new Error(
        'Cloud Scheduler requires CLOUD_SCHEDULER_PROJECT_ID, '
        + 'CLOUD_SCHEDULER_LOCATION, and either PUBLIC_BASE_URL or CLOUD_SCHEDULER_DISPATCH_URL',
      );
    }
    (staticMode === 'cloud' ? staticJobs : dynamicJobs).setMirror(mirror);
  }

  return {
    staticMode,
    dynamicMode,
    staticJobs,
    dynamicJobs,
    async runNow(name) {
      if (dynamicJobs.registeredJobs.includes(name)) return dynamicJobs.runNow(name);
      if (staticJobs !== dynamicJobs) return staticJobs.runNow(name);
      return false;
    },
    async sync() {
      await dynamicJobs.sync();
      if (staticJobs !== dynamicJobs) await staticJobs.sync();
    },
    shutdown() {
      dynamicJobs.shutdown();
      if (staticJobs !== dynamicJobs) staticJobs.shutdown();
    },
  };
}

export async function dispatchScheduledJob(
  runtime: SchedulerRuntime,
  ledger: {
    claimSchedulerDispatch(id: string, jobName: string): Promise<boolean>;
    finishSchedulerDispatch(id: string, success: boolean): Promise<void>;
  },
  name: string,
  occurrenceId?: string,
): Promise<boolean> {
  const known = runtime.dynamicJobs.registeredJobs.includes(name) || runtime.staticJobs.registeredJobs.includes(name);
  if (!known) return false;
  if (occurrenceId && !await ledger.claimSchedulerDispatch(occurrenceId, name)) {
    console.info(JSON.stringify({ event: 'scheduler_dispatch_duplicate_skipped', job: name }));
    return true;
  }
  try {
    const executed = await runtime.runNow(name);
    if (occurrenceId) await ledger.finishSchedulerDispatch(occurrenceId, executed);
    return executed;
  } catch (error) {
    if (occurrenceId) {
      try {
        await ledger.finishSchedulerDispatch(occurrenceId, false);
      } catch (ledgerError) {
        console.error(JSON.stringify({ event: 'scheduler_dispatch_ledger_error', job: name, ...safeErrorInfo(ledgerError) }));
      }
    }
    throw error;
  }
}
