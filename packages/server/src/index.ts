import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

import { config } from "dotenv";

config();

const port = Number(process.env.PORT ?? 4410);
const dbPath = process.env.DB_PATH ?? "./run/labby.db";

const { app } = createApp({
  dbPath,
  enableLogger: true,
  authIssuer: process.env.AUTH_ISSUER,
  authAudience: process.env.AUTH_AUDIENCE,
  accessTtl: process.env.AUTH_ACCESS_TTL,
  refreshTtl: process.env.AUTH_REFRESH_TTL,
  pasetoSecret: process.env.PASETO_SECRET,
  pasetoAccessKey: process.env.PASETO_ACCESS_KEY,
  pasetoRefreshKey: process.env.PASETO_REFRESH_KEY,
  bootstrapUsername: process.env.BOOTSTRAP_ADMIN_USERNAME,
  bootstrapPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  bootstrapEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
});


serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Labby server listening on http://localhost:${info.port}`);
});
