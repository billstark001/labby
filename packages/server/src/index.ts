import { serve } from "@hono/node-server";
import { createBackupServiceFromEnv, setActiveBackupService } from "./backup/service.js";
import { createApp } from "./app.js";
import { createAuthMaintenanceServiceFromEnv } from "./cron/auth-maintenance.js";
import { createSchedulerRuntimeFromEnv, dispatchScheduledJob } from "./cron/scheduler-runtime.js";
import { createMailerFromEnv } from "./lib/mailer.js";
import type { EmailTaskNotifier as EmailTaskNotifierType } from "./cron/email-task-notifier.js";
import { resolvePublicBaseUrl, resolveStoreConnectionConfig } from "./lib/runtime-config.js";
import { safeErrorInfo } from './lib/logging.js';

const port = Number(process.env.PORT ?? 4410);
const dbConfig = resolveStoreConnectionConfig(process.env);
const publicBaseUrl = resolvePublicBaseUrl(process.env, port);

const schedulers = createSchedulerRuntimeFromEnv();

let emailTaskNotifier: EmailTaskNotifierType | null = null;
let scheduleNotifier: { syncJobs(): Promise<void> } | null = null;
let dynamicSync = Promise.resolve();
const refreshDynamicJobs = (syncRemote: boolean): Promise<void> => {
  const next = dynamicSync.catch(() => {}).then(async () => {
    await scheduleNotifier?.syncJobs();
    await emailTaskNotifier?.syncJobs();
    if (syncRemote) await schedulers.sync();
  });
  dynamicSync = next;
  return next;
};
const syncDynamicJobs = (): Promise<void> => refreshDynamicJobs(true);
let schedulerDispatchHandler: (jobName: string, occurrenceId?: string) => Promise<boolean> = async () => {
  throw new Error('Scheduler dispatch is not ready');
};
const mailer = createMailerFromEnv();

const { app, store, close } = await createApp({
  db: dbConfig,
  webDistDir: process.env.WEB_DIST_DIR,
  enableLogger: true,
  authIssuer: process.env.AUTH_ISSUER,
  authAudience: process.env.AUTH_AUDIENCE,
  accessTtl: process.env.AUTH_ACCESS_TTL,
  refreshTtl: process.env.AUTH_REFRESH_TTL,
  pasetoSecret: process.env.PASETO_SECRET,
  pasetoAccessKey: process.env.PASETO_ACCESS_KEY,
  pasetoRefreshKey: process.env.PASETO_REFRESH_KEY,
  rootUsername: process.env.ROOT_USERNAME,
  rootPassword: process.env.ROOT_PASSWORD,
  rootEmail: process.env.ROOT_EMAIL,
  mailer,
  onEmailTasksChanged: syncDynamicJobs,
  onConfigsChanged: syncDynamicJobs,
  onSchedulesChanged: syncDynamicJobs,
  runEmailTaskNow: async (taskId: string, recipients: string[]) => {
    if (!emailTaskNotifier) {
      throw new Error('email task notifier is not configured');
    }
    return emailTaskNotifier.runTaskNow(taskId, recipients);
  },
  schedulerDispatchApiKey: process.env.SCHEDULER_DISPATCH_API_KEY,
  onSchedulerDispatch: (jobName, occurrenceId) => schedulerDispatchHandler(jobName, occurrenceId),
});
schedulerDispatchHandler = async (jobName, occurrenceId) => {
  if (jobName.startsWith('email-task:') || jobName.startsWith('schedule-notify:')) {
    // Another replica may have handled the mutation that changed this job.
    await refreshDynamicJobs(false);
  }
  return dispatchScheduledJob(schedulers, store, jobName, occurrenceId);
};

// Email / cron subsystem (optional – only starts if SMTP is configured)
if (mailer) {
  // Network verification can outlast Railway's healthcheck window. It must not
  // delay the HTTP listener; failed delivery remains visible in the logs.
  void mailer.verify().then((mailerOk) => {
    if (!mailerOk) {
      console.warn('[mail] Mailer configured but verify() failed. Check the mail provider and credentials.');
    } else {
      console.info('[mail] Mailer verify() succeeded.');
    }
  }).catch((error: unknown) => {
    console.warn(JSON.stringify({ event: 'mailer_verification_error', ...safeErrorInfo(error) }));
  });

  const recipients = (process.env.NOTIFY_RECIPIENTS ?? "")
    .split(",")
    .map(r => r.trim())
    .filter(Boolean);

  const { ScheduleNotifier } = await import("./cron/notifier.js");
  const { EmailTaskNotifier } = await import("./cron/email-task-notifier.js");
  scheduleNotifier = new ScheduleNotifier({ scheduler: schedulers.dynamicJobs, mailer, store, recipients });
  emailTaskNotifier = new EmailTaskNotifier({
    scheduler: schedulers.dynamicJobs,
    mailer,
    store,
    publicBaseUrl,
  });
  await refreshDynamicJobs(false);
  console.info(`[cron] Email notifications enabled. Registered ${schedulers.dynamicJobs.registeredJobs.length} dynamic job(s).`);
} else {
  console.info("[cron] SMTP not configured; email notifications disabled.");
}

const authMaintenanceService = createAuthMaintenanceServiceFromEnv({
  scheduler: schedulers.staticJobs,
  store,
});
authMaintenanceService.syncJobs();
console.info(`[auth] Cleanup scheduler ready. Registered ${schedulers.staticJobs.registeredJobs.length} static job(s).`);

const backupService = createBackupServiceFromEnv({
  scheduler: schedulers.staticJobs,
  store,
  mailer,
});

setActiveBackupService(backupService);

if (backupService) {
  backupService.syncJobs();
  console.info(`[backup] Backup service ready. Configured target: ${backupService.targetDescription}.`);
} else {
  console.info("[backup] Database backups disabled.");
}

// A cloud-mode process must not become healthy while its schedule is missing.
await schedulers.sync();
console.info(`[scheduler] Static mode: ${schedulers.staticMode}; dynamic mode: ${schedulers.dynamicMode}; static jobs: ${schedulers.staticJobs.registeredJobs.length}; dynamic jobs: ${schedulers.dynamicJobs.registeredJobs.length}.`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Labby server listening on http://localhost:${info.port}`);
});

// Graceful shutdown
const shutdown = () => {
  schedulers.shutdown();
  server.close(async () => {
    await close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
