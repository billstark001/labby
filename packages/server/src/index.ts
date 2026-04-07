import { serve } from "@hono/node-server";
import { createBackupServiceFromEnv, setActiveBackupService } from "./backup/service.js";
import { createApp } from "./app.js";
import { createCloudSchedulerMirrorFromEnv } from "./cron/cloud-scheduler.js";
import { createAuthMaintenanceServiceFromEnv } from "./cron/auth-maintenance.js";
import { resolveSchedulerMode, scheduler, type SchedulerMode } from "./cron/scheduler.js";
import { createMailerFromEnv } from "./lib/mailer.js";
import type { StoreConnectionConfig } from "./store/index.js";
import type { EmailTaskNotifier as EmailTaskNotifierType } from "./cron/email-task-notifier.js";

import { config } from "dotenv";

config();

const requestedSchedulerMode = resolveSchedulerMode(process.env.SCHEDULER_MODE);
let schedulerMode: SchedulerMode = requestedSchedulerMode;
if (requestedSchedulerMode !== 'cron') {
  const mirror = createCloudSchedulerMirrorFromEnv();
  if (mirror) {
    scheduler.setMirror(mirror);
  } else if (requestedSchedulerMode === 'cloud') {
    schedulerMode = 'cron';
    console.warn('[scheduler] SCHEDULER_MODE=cloud but cloud scheduler env is incomplete, falling back to cron mode.');
  } else {
    console.warn('[scheduler] SCHEDULER_MODE=hybrid but cloud scheduler env is incomplete, cloud sync is disabled.');
  }
}
scheduler.setMode(schedulerMode);

const port = Number(process.env.PORT ?? 4410);
const dbPath = process.env.DB_PATH ?? "./run/labby.db";
const dbDriver = process.env.DB_DRIVER?.trim().toLowerCase();
const enablePublicEmailTaskIcs = /^(1|true|yes)$/i.test(process.env.ENABLE_PUBLIC_EMAIL_TASK_ICS ?? '');
const publicBaseUrl = (process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`);

const dbConfig: StoreConnectionConfig = dbDriver === "postgres"
  ? {
    dialect: "postgres",
    connectionString: process.env.DATABASE_URL ?? "",
    ssl: process.env.DATABASE_SSL === "1" || process.env.DATABASE_SSL === "true",
  }
  : {
    dialect: "sqlite",
    path: dbPath,
  };

if (dbConfig.dialect === "postgres" && !dbConfig.connectionString) {
  throw new Error("DATABASE_URL is required when DB_DRIVER=postgres");
}

let emailTaskNotifier: EmailTaskNotifierType | null = null;
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
  enablePublicEmailTaskIcs,
  mailer,
  onEmailTasksChanged: async () => {
    await emailTaskNotifier?.syncJobs();
  },
  runEmailTaskNow: async (taskId: string) => {
    if (!emailTaskNotifier) {
      throw new Error('email task notifier is not configured');
    }
    await emailTaskNotifier.runTaskNow(taskId);
  },
  schedulerDispatchApiKey: process.env.SCHEDULER_DISPATCH_API_KEY,
  onSchedulerDispatch: async (jobName: string) => scheduler.runNow(jobName),
});

// Email / cron subsystem (optional – only starts if SMTP is configured)
if (mailer) {
  const mailerOk = await mailer.verify();
  if (!mailerOk) {
    console.warn('[mail] Mailer configured but verify() failed. Check Gmail OAuth/SMTP credentials.');
  } else {
    console.info('[mail] Mailer verify() succeeded.');
  }

  const recipients = (process.env.NOTIFY_RECIPIENTS ?? "")
    .split(",")
    .map(r => r.trim())
    .filter(Boolean);

  const { ScheduleNotifier } = await import("./cron/notifier.js");
  const { EmailTaskNotifier } = await import("./cron/email-task-notifier.js");
  const notifier = new ScheduleNotifier({ scheduler, mailer, store, recipients });
  emailTaskNotifier = new EmailTaskNotifier({
    scheduler,
    mailer,
    store,
    enablePublicEmailTaskIcs,
    publicBaseUrl,
  });
  await notifier.syncJobs();
  await emailTaskNotifier.syncJobs();
  console.info(`[cron] Email notifications enabled. Registered ${scheduler.registeredJobs.length} job(s).`);
} else {
  console.info("[cron] SMTP not configured; email notifications disabled.");
}

const authMaintenanceService = createAuthMaintenanceServiceFromEnv({
  scheduler,
  store,
});
authMaintenanceService.syncJobs();
console.info(`[auth] Cleanup scheduler ready. Registered ${scheduler.registeredJobs.length} job(s).`);

const backupService = createBackupServiceFromEnv({
  scheduler,
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

if (scheduler.hasMirror) {
  try {
    await scheduler.syncMirrorNow();
    console.info(`[scheduler] Mirrored ${scheduler.registeredJobs.length} job(s) to Cloud Scheduler.`);
  } catch (err) {
    console.error('[scheduler] Failed to sync jobs to Cloud Scheduler:', err);
  }
}

console.info(`[scheduler] Mode: ${scheduler.getMode()}; registered jobs: ${scheduler.registeredJobs.length}.`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Labby server listening on http://localhost:${info.port}`);
});

// Graceful shutdown
const shutdown = () => {
  scheduler.shutdown();
  server.close(async () => {
    await close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
