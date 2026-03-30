import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { logger } from "hono/logger";
import { z } from "zod";

import type {
  Keyword,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
  SimilarityEdge,
} from "@labby/core";

import { AuthService, resolvePasetoKey } from "./lib/auth.js";
import { AppError } from "./lib/errors.js";
import { fail, ok } from "./lib/http.js";
import { getAuthSession, requireClientAuth, requireRequestId } from "./http/middleware.js";
import { SqliteStore } from "./store/sqlite.js";

export interface CreateAppOptions {
  dbPath: string;
  enableLogger?: boolean;
  authIssuer?: string;
  authAudience?: string;
  accessTtl?: string;
  refreshTtl?: string;
  pasetoSecret?: string;
  pasetoAccessKey?: string;
  pasetoRefreshKey?: string;
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  bootstrapEmail?: string;
}

export function createApp(options: CreateAppOptions): { app: Hono; } {

  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });

  const store = new SqliteStore(options.dbPath);
  const authService = new AuthService({
    store,
    issuer: options.authIssuer ?? "labby-server",
    audience: options.authAudience ?? "labby-web",
    accessTtl: options.accessTtl ?? "15m",
    refreshTtl: options.refreshTtl ?? "30d",
    accessKey: resolvePasetoKey(options.pasetoAccessKey ?? options.pasetoSecret, "access"),
    refreshKey: resolvePasetoKey(options.pasetoRefreshKey ?? options.pasetoSecret, "refresh"),
  });

  if (options.bootstrapUsername && options.bootstrapPassword) {
    void authService.bootstrapUser({
      username: options.bootstrapUsername,
      password: options.bootstrapPassword,
      email: options.bootstrapEmail,
      role: "admin",
    });
  }

  const loginBodySchema = z.object({
    password: z.string().min(1),
    identity: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  }).refine(value => Boolean(value.identity || value.username || value.email), {
    message: "identity, username, or email is required",
  });

  const refreshBodySchema = z.object({
    refresh_token: z.string().min(1),
  });

  const app = new Hono();
  if (options.enableLogger ?? true) {
    app.use("*", logger());
  }
  app.use("/api/v1/*", requireRequestId);
  app.use("/api/v1/db/*", requireClientAuth(authService));
  app.use("/api/v1/auth/logout", requireClientAuth(authService));

  app.get("/health", (c) => c.json({ ok: true, now: Date.now() }));

  app.post("/api/v1/auth/login", async (c) => {
    const body = loginBodySchema.parse(await c.req.json());
    const identity = body.identity ?? body.username ?? body.email ?? "";
    const tokens = await authService.login(identity, body.password);

    setCookie(c, "labby_refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: c.req.url.startsWith("https://"),
      sameSite: "Strict",
      path: "/api/v1/auth",
      maxAge: 30 * 24 * 60 * 60,
    });

    return c.json(tokens);
  });

  app.post("/api/v1/auth/refresh", async (c) => {
    const parsed = refreshBodySchema.safeParse(await c.req.json().catch(() => ({})));
    const refreshToken = parsed.success
      ? parsed.data.refresh_token
      : c.req.header("Cookie")?.match(/(?:^|; )labby_refresh_token=([^;]+)/)?.[1];

    if (!refreshToken) {
      throw new AppError("AUTH_INVALID", "refresh token is required", 401);
    }

    const tokens = await authService.refresh(decodeURIComponent(refreshToken));
    setCookie(c, "labby_refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: c.req.url.startsWith("https://"),
      sameSite: "Strict",
      path: "/api/v1/auth",
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json(tokens);
  });

  app.post("/api/v1/auth/logout", (c) => {
    const session = getAuthSession(c);
    authService.logout(session.userId);
    deleteCookie(c, "labby_refresh_token", { path: "/api/v1/auth" });
    return c.body(null, 204);
  });

  app.get("/api/v1/auth/me", requireClientAuth(authService), (c) => {
    return ok(c, getAuthSession(c));
  });

  app.get("/api/v1/db/persons", (c) => ok(c, store.listPersons()));
  app.get("/api/v1/db/persons/:id", (c) => ok(c, store.getPerson(c.req.param("id")) ?? null));
  app.put("/api/v1/db/persons/:id", async (c) => {
    const person = await c.req.json<Person>();
    store.putPerson({ ...person, id: c.req.param("id") });
    return ok(c, store.getPerson(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/persons/:id", (c) => {
    store.deletePerson(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/keywords", (c) => ok(c, store.listKeywords()));
  app.get("/api/v1/db/keywords/:id", (c) => ok(c, store.getKeyword(c.req.param("id")) ?? null));
  app.put("/api/v1/db/keywords/:id", async (c) => {
    const keyword = await c.req.json<Keyword>();
    store.putKeyword({ ...keyword, id: c.req.param("id") });
    return ok(c, store.getKeyword(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/keywords/:id", (c) => {
    store.deleteKeyword(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/similarities", (c) => ok(c, store.listSimilarities()));
  app.get("/api/v1/db/similarities/:sourceId/:targetId", (c) => {
    return ok(c, store.getSimilarity(c.req.param("sourceId"), c.req.param("targetId")) ?? null);
  });
  app.put("/api/v1/db/similarities/:sourceId/:targetId", async (c) => {
    const edge = await c.req.json<SimilarityEdge>();
    store.putSimilarity({
      ...edge,
      sourceId: c.req.param("sourceId"),
      targetId: c.req.param("targetId"),
    });
    return ok(c, store.getSimilarity(c.req.param("sourceId"), c.req.param("targetId")), 201);
  });
  app.delete("/api/v1/db/similarities/:sourceId/:targetId", (c) => {
    store.deleteSimilarity(c.req.param("sourceId"), c.req.param("targetId"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/configs", (c) => ok(c, store.listConfigs()));
  app.get("/api/v1/db/configs/:id", (c) => ok(c, store.getConfig(c.req.param("id")) ?? null));
  app.put("/api/v1/db/configs/:id", async (c) => {
    const config = await c.req.json<ScheduleConfig>();
    store.putConfig({ ...config, id: c.req.param("id") });
    return ok(c, store.getConfig(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/configs/:id", (c) => {
    store.deleteConfig(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/schedules", (c) => ok(c, store.listSchedules()));
  app.get("/api/v1/db/schedules/:id", (c) => ok(c, store.getSchedule(c.req.param("id")) ?? null));
  app.put("/api/v1/db/schedules/:id", async (c) => {
    const schedule = await c.req.json<SchedulePlan>();
    store.putSchedule({ ...schedule, id: c.req.param("id") });
    return ok(c, store.getSchedule(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/schedules/:id", (c) => {
    store.deleteSchedule(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/unavailabilities", (c) => ok(c, store.listUnavailabilities()));
  app.get("/api/v1/db/unavailabilities/:id", (c) => ok(c, store.getUnavailability(c.req.param("id")) ?? null));
  app.put("/api/v1/db/unavailabilities/:id", async (c) => {
    const unavailability = await c.req.json<PersonUnavailability>();
    store.putUnavailability({ ...unavailability, id: c.req.param("id") });
    return ok(c, store.getUnavailability(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/unavailabilities/:id", (c) => {
    store.deleteUnavailability(c.req.param("id"));
    return c.body(null, 204);
  });


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
