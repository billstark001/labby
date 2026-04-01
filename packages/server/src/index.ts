import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { scheduler } from "./cron/scheduler.js";
import { createMailerFromEnv } from "./lib/mailer.js";

import { config } from "dotenv";

config();

const port = Number(process.env.PORT ?? 4410);
const dbPath = process.env.DB_PATH ?? "./run/labby.db";

const { app, store } = createApp({
  dbPath,
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
});

// Email / cron subsystem (optional – only starts if SMTP is configured)
const mailer = createMailerFromEnv();
if (mailer) {
  const recipients = (process.env.NOTIFY_RECIPIENTS ?? "")
    .split(",")
    .map(r => r.trim())
    .filter(Boolean);

  const { ScheduleNotifier } = await import("./cron/notifier.js");
  const notifier = new ScheduleNotifier({ scheduler, mailer, store, recipients });
  notifier.syncJobs();
  console.info(`[cron] Email notifications enabled. Registered ${scheduler.registeredJobs.length} job(s).`);
} else {
  console.info("[cron] SMTP not configured; email notifications disabled.");
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Labby server listening on http://localhost:${info.port}`);
});

// Graceful shutdown
const shutdown = () => {
  scheduler.shutdown();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
