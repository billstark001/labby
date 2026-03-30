import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { z } from "zod";

import { AppError } from "./lib/errors.js";
import { fail } from "./lib/http.js";
import { requireRequestId } from "./http/middleware.js";

export interface CreateAppOptions {
  dbPath: string;
  enableLogger?: boolean;
}

export function createApp(options: CreateAppOptions): { app: Hono; } {

  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });

  const app = new Hono();
  if (options.enableLogger ?? true) {
    app.use("*", logger());
  }
  app.use("/v1/*", requireRequestId);

  app.get("/health", (c) => c.json({ ok: true, now: Date.now() }));


  app.onError((err, c) => {
    if (err instanceof AppError) {
      return fail(c, err.code, err.message, err.status);
    }
    if (err instanceof z.ZodError) {
      return fail(c, "VALIDATION_ERROR", err.issues.map((i) => i.message).join("; "), 400);
    }
    console.error(err);
    return fail(c, "INTERNAL_ERROR", "internal server error", 500);
  });

  app.notFound((c) => fail(c, "VALIDATION_ERROR", "route not found", 404));

  return { app };
}
