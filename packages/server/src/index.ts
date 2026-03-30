import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

import { config } from "dotenv";

config();

const port = Number(process.env.PORT ?? 4410);
const dbPath = process.env.DB_PATH ?? "./run/labby.db";

const { app } = createApp({
  dbPath,
  enableLogger: true,
});


serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Labby server listening on http://localhost:${info.port}`);
});
