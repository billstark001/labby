import { serve } from "@hono/node-server";
import { createBackupServiceFromEnv, setActiveBackupService } from "./backup/service.js";
import { createApp } from "./app.js";
import { scheduler } from "./cron/scheduler.js";
import { createMailerFromEnv } from "./lib/mailer.js";
import type { StoreConnectionConfig } from "./store/index.js";
import type { EmailTaskNotifier as EmailTaskNotifierType } from "./cron/email-task-notifier.js";

import { config } from "dotenv";

config();

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

const { app, store, close } = await createApp({
  db: dbConfig,
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
  bootstrapUsername: process.env.BOOTSTRAP_ADMIN_USERNAME,
  bootstrapPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
  enablePublicEmailTaskIcs,
  onEmailTasksChanged: async () => {
    await emailTaskNotifier?.syncJobs();
  },
  runEmailTaskNow: async (taskId: string) => {
    if (!emailTaskNotifier) {
      throw new Error('email task notifier is not configured');
    }
    await emailTaskNotifier.runTaskNow(taskId);
  },
});

// Email / cron subsystem (optional – only starts if SMTP is configured)
const mailer = createMailerFromEnv();
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
