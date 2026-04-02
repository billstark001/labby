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
import {
  solveFull,
  solveIncremental,
  applyTripletStep,
  embeddingsToSimilarities,
  initEmbeddings,
  cloneEmbeddings,
  type EmbeddingMap,
} from "@labby/core";

import { AuthService, UserRole, resolvePasetoKey } from "./lib/auth.js";
import { getActiveBackupService } from "./backup/service.js";
import { AppError } from "./lib/errors.js";
import { fail, ok } from "./lib/http.js";
import {
  getAuthSession,
  requireClientAuth,
  requireMinRole,
  requireRequestId,
} from "./http/middleware.js";
import { SqliteStore, type StoreConnectionConfig } from "./store/index.js";

export interface CreateAppOptions {
  dbPath?: string;
  db?: StoreConnectionConfig;
  enableLogger?: boolean;
  authIssuer?: string;
  authAudience?: string;
  accessTtl?: string;
  refreshTtl?: string;
  pasetoSecret?: string;
  pasetoAccessKey?: string;
  pasetoRefreshKey?: string;
  /** Root user credentials from environment (never stored in DB). */
  rootUsername?: string;
  rootPassword?: string;
  rootEmail?: string;
  /** Bootstrap admin account (created on first run if no admin exists). */
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  bootstrapEmail?: string;
}

export function createApp(options: CreateAppOptions): { app: Hono; store: SqliteStore; } {
  const dbConfig = options.db ?? { dialect: "sqlite", path: options.dbPath ?? "./run/labby.db" };
  if (dbConfig.dialect === "sqlite") {
    fs.mkdirSync(path.dirname(dbConfig.path), { recursive: true });
  }

  const store = new SqliteStore(dbConfig);
  const authService = new AuthService({
    store,
    issuer: options.authIssuer ?? "labby-server",
    audience: options.authAudience ?? "labby-web",
    accessTtl: options.accessTtl ?? "15m",
    refreshTtl: options.refreshTtl ?? "30d",
    accessKey: resolvePasetoKey(options.pasetoAccessKey ?? options.pasetoSecret, "access"),
    refreshKey: resolvePasetoKey(options.pasetoRefreshKey ?? options.pasetoSecret, "refresh"),
    rootUsername: options.rootUsername,
    rootPassword: options.rootPassword,
    rootEmail: options.rootEmail,
  });

  // Bootstrap an initial admin account (from env) on first run
  if (options.bootstrapUsername && options.bootstrapPassword) {
    void authService.bootstrapUser({
      username: options.bootstrapUsername,
      password: options.bootstrapPassword,
      email: options.bootstrapEmail,
      role: UserRole.Admin,
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

  const issueUserBodySchema = z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(8),
    email: z.string().email().optional(),
    role: z.number().int().min(0).max(1),
  });

  const app = new Hono();

  function parsePagination(input: { offset?: string; limit?: string }): { offset: number; limit: number } {
    const rawOffset = Number.parseInt(input.offset ?? '0', 10);
    const rawLimit = Number.parseInt(input.limit ?? '20', 10);
    return {
      offset: Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0,
      limit: Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 20,
    };
  }

  function toPage<T>(items: T[], offset: number, limit: number): { items: T[]; total: number; offset: number; limit: number } {
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
    };
  }

  if (options.enableLogger ?? true) {
    app.use("*", logger());
  }
  app.use("/api/v1/*", requireRequestId);
  app.use("/api/v1/db/*", requireClientAuth(authService));
  app.use("/api/v1/solver/*", requireClientAuth(authService));
  app.use("/api/v1/nlp/*", requireClientAuth(authService));
  app.use("/api/v1/users/*", requireClientAuth(authService));
  app.use("/api/v1/system/*", requireClientAuth(authService));
  app.use("/api/v1/auth/logout", requireClientAuth(authService));

  // Write operations require at least admin role
  app.use("/api/v1/db/*", async (c, next) => {
    if (c.req.method !== "GET") {
      return requireMinRole(UserRole.Admin)(c, next);
    }
    return next();
  });
  app.use("/api/v1/solver/*", requireMinRole(UserRole.Admin));
  app.use("/api/v1/nlp/*", requireMinRole(UserRole.Admin));
  app.use("/api/v1/system/backup/*", requireMinRole(UserRole.Admin));

  app.get("/health", (c) => c.json({ ok: true, now: Date.now() }));

  app.get("/api/v1/system/capabilities", (c) => {
    const session = getAuthSession(c);
    const backupService = getActiveBackupService();
    return ok(c, {
      deploymentMode: 'server',
      backup: backupService?.getCapabilities() ?? {
        scheduleEnabled: false,
        scheduleConfigured: false,
        configuredTarget: null,
        configuredFormat: 'sqlite',
        targets: {
          email: false,
          'google-drive': false,
          onedrive: false,
        },
        formats: ['sqlite', 'msgpack'],
      },
      permissions: {
        canManageBackups: session.role >= UserRole.Admin,
      },
    });
  });

  const backupActionSchema = z.object({
    format: z.enum(['sqlite', 'msgpack']).optional(),
    target: z.enum(['email', 'google-drive', 'onedrive']).optional(),
  });

  app.post("/api/v1/system/backup/run", async (c) => {
    const backupService = getActiveBackupService();
    if (!backupService) {
      throw new AppError('BACKUP_UNAVAILABLE', 'backup service is unavailable', 503);
    }
    const body = backupActionSchema.parse(await c.req.json().catch(() => ({})));
    await backupService.dispatchBackup(body);
    return ok(c, { ok: true });
  });

  app.get("/api/v1/system/backup/download", async (c) => {
    const backupService = getActiveBackupService();
    if (!backupService) {
      throw new AppError('BACKUP_UNAVAILABLE', 'backup service is unavailable', 503);
    }
    const formatQuery = c.req.query('format');
    const format = formatQuery === 'msgpack' ? 'msgpack' : 'sqlite';
    const artifact = await backupService.createDownloadArtifact(format);
    c.header('Content-Type', artifact.contentType);
    c.header('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    return c.body(new Uint8Array(artifact.content));
  });

  app.post('/api/v1/system/backup/restore', async (c) => {
    const backupService = getActiveBackupService();
    if (!backupService) {
      throw new AppError('BACKUP_UNAVAILABLE', 'backup service is unavailable', 503);
    }

    const formatQuery = c.req.query('format');
    if (formatQuery !== 'sqlite' && formatQuery !== 'msgpack') {
      throw new AppError('VALIDATION_ERROR', 'format must be sqlite or msgpack', 400);
    }

    const payload = Buffer.from(await c.req.arrayBuffer());
    if (payload.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'backup payload is empty', 400);
    }

    await backupService.restoreBackupArtifact({
      format: formatQuery,
      content: payload,
    });

    return ok(c, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // Auth routes
  // ---------------------------------------------------------------------------

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

  app.post("/api/v1/auth/logout", async (c) => {
    const session = getAuthSession(c);
    await authService.logout(session.userId);
    deleteCookie(c, "labby_refresh_token", { path: "/api/v1/auth" });
    return c.body(null, 204);
  });

  app.get("/api/v1/auth/me", requireClientAuth(authService), (c) => {
    return ok(c, getAuthSession(c));
  });

  // ---------------------------------------------------------------------------
  // User management routes (admin/root only)
  // ---------------------------------------------------------------------------

  app.post("/api/v1/users", requireMinRole(UserRole.Admin), async (c) => {
    const body = issueUserBodySchema.parse(await c.req.json());
    const session = getAuthSession(c);
    const user = await authService.issueUser({
      username: body.username,
      password: body.password,
      email: body.email,
      role: body.role as typeof UserRole.Admin | typeof UserRole.User,
      issuerRole: session.role,
    });
    const { passwordHash: _, ...safeUser } = user;
    return ok(c, safeUser, 201);
  });

  app.get("/api/v1/users", requireMinRole(UserRole.Admin), async (c) => {
    const users = (await store.listUsers()).map(({ passwordHash: _, ...u }) => u);
    return ok(c, users);
  });

  // ---------------------------------------------------------------------------
  // Database CRUD routes
  // ---------------------------------------------------------------------------

  app.get("/api/v1/db/persons", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listPersons(), offset, limit));
  });
  app.get("/api/v1/db/persons/:id", async (c) => ok(c, (await store.getPerson(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/persons/:id", async (c) => {
    const person = await c.req.json<Person>();
    await store.putPerson({ ...person, id: c.req.param("id") });
    return ok(c, await store.getPerson(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/persons/:id", async (c) => {
    await store.deletePerson(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/keywords", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listKeywords(), offset, limit));
  });
  app.get("/api/v1/db/keywords/:id", async (c) => ok(c, (await store.getKeyword(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/keywords/:id", async (c) => {
    const keyword = await c.req.json<Keyword>();
    await store.putKeyword({ ...keyword, id: c.req.param("id") });
    return ok(c, await store.getKeyword(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/keywords/:id", async (c) => {
    await store.deleteKeyword(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/similarities", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listSimilarities(), offset, limit));
  });
  app.get("/api/v1/db/similarities/:sourceId/:targetId", async (c) => {
    return ok(c, (await store.getSimilarity(c.req.param("sourceId"), c.req.param("targetId"))) ?? null);
  });
  app.put("/api/v1/db/similarities/:sourceId/:targetId", async (c) => {
    const edge = await c.req.json<SimilarityEdge>();
    await store.putSimilarity({
      ...edge,
      sourceId: c.req.param("sourceId"),
      targetId: c.req.param("targetId"),
    });
    return ok(c, await store.getSimilarity(c.req.param("sourceId"), c.req.param("targetId")), 201);
  });
  app.delete("/api/v1/db/similarities/:sourceId/:targetId", async (c) => {
    await store.deleteSimilarity(c.req.param("sourceId"), c.req.param("targetId"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/configs", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listConfigs(), offset, limit));
  });
  app.get("/api/v1/db/configs/:id", async (c) => ok(c, (await store.getConfig(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/configs/:id", async (c) => {
    const config = await c.req.json<ScheduleConfig>();
    await store.putConfig({ ...config, id: c.req.param("id") });
    return ok(c, await store.getConfig(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/configs/:id", async (c) => {
    await store.deleteConfig(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/schedules", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listSchedules(), offset, limit));
  });
  app.get("/api/v1/db/schedules/:id", async (c) => ok(c, (await store.getSchedule(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/schedules/:id", async (c) => {
    const schedule = await c.req.json<SchedulePlan>();
    await store.putSchedule({ ...schedule, id: c.req.param("id") });
    return ok(c, await store.getSchedule(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/schedules/:id", async (c) => {
    await store.deleteSchedule(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/v1/db/unavailabilities", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listUnavailabilities(), offset, limit));
  });
  app.get("/api/v1/db/unavailabilities/:id", async (c) => ok(c, (await store.getUnavailability(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/unavailabilities/:id", async (c) => {
    const unavailability = await c.req.json<PersonUnavailability>();
    await store.putUnavailability({ ...unavailability, id: c.req.param("id") });
    return ok(c, await store.getUnavailability(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/unavailabilities/:id", async (c) => {
    await store.deleteUnavailability(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------------------
  // Solver routes (call @labby/core)
  // ---------------------------------------------------------------------------

  const solverInputSchema = z.object({
    configId: z.string().min(1),
    personIds: z.array(z.string()).optional(),
  });

  const solverIncrementalInputSchema = z.object({
    configId: z.string().min(1),
    previousPlanId: z.string().min(1),
    changeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    personIds: z.array(z.string()).optional(),
  });

  app.post("/api/v1/solver/run", async (c) => {
    const body = solverInputSchema.parse(await c.req.json());
    const config = await store.getConfig(body.configId);
    if (!config) throw new AppError("VALIDATION_ERROR", "config not found", 404);

    const allPersons = await store.listPersons();
    const persons = body.personIds
      ? allPersons.filter(p => body.personIds!.includes(p.id))
      : allPersons;
    const similarities = await store.listSimilarities();
    const unavailabilities = await store.listUnavailabilities();

    const simMap = new Map<string, number>();
    for (const e of similarities) {
      const [a, b] = e.sourceId < e.targetId ? [e.sourceId, e.targetId] : [e.targetId, e.sourceId];
      simMap.set(`${a}|${b}`, e.weight);
    }

    const plan = solveFull({ persons, similarities: simMap, config, unavailabilities });
    return ok(c, plan);
  });

  app.post("/api/v1/solver/run-incremental", async (c) => {
    const body = solverIncrementalInputSchema.parse(await c.req.json());
    const config = await store.getConfig(body.configId);
    if (!config) throw new AppError("VALIDATION_ERROR", "config not found", 404);
    const previousPlan = await store.getSchedule(body.previousPlanId);
    if (!previousPlan) throw new AppError("VALIDATION_ERROR", "previous plan not found", 404);

    const allPersons = await store.listPersons();
    const persons = body.personIds
      ? allPersons.filter(p => body.personIds!.includes(p.id))
      : allPersons;
    const similarities = await store.listSimilarities();
    const unavailabilities = await store.listUnavailabilities();

    const simMap = new Map<string, number>();
    for (const e of similarities) {
      const [a, b] = e.sourceId < e.targetId ? [e.sourceId, e.targetId] : [e.targetId, e.sourceId];
      simMap.set(`${a}|${b}`, e.weight);
    }

    const plan = solveIncremental({
      persons,
      similarities: simMap,
      config,
      unavailabilities,
      previousPlan,
      changeDate: body.changeDate,
    });
    return ok(c, plan);
  });

  // ---------------------------------------------------------------------------
  // NLP / embedding routes (call @labby/core)
  // ---------------------------------------------------------------------------

  const tripletUpdateSchema = z.object({
    anchorId: z.string().min(1),
    positiveId: z.string().min(1),
    negativeId: z.string().min(1),
    learningRate: z.number().optional(),
    embeddings: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  });

  app.post("/api/v1/nlp/update-similarity", async (c) => {
    const body = tripletUpdateSchema.parse(await c.req.json());

    const allKeywords = await store.listKeywords();
    const keywordIds = allKeywords.map(k => k.id);

    let embeddings: EmbeddingMap;
    if (body.embeddings) {
      embeddings = new Map(Object.entries(body.embeddings));
    } else {
      embeddings = initEmbeddings(keywordIds);
    }

    // Apply one triplet gradient step (modifies embeddings clone in-place)
    const updated = cloneEmbeddings(embeddings);
    applyTripletStep(
      updated,
      { anchorId: body.anchorId, positiveId: body.positiveId, negativeId: body.negativeId },
      body.learningRate,
    );

    // Recompute and persist similarities from updated embeddings
    const simMap = embeddingsToSimilarities(updated);
    const updatedPairs: SimilarityEdge[] = [];
    for (const [key, weight] of simMap) {
      const [sourceId, targetId] = key.split('|');
      if (!sourceId || !targetId) continue;
      await store.putSimilarity({ sourceId, targetId, weight });
      updatedPairs.push({ sourceId, targetId, weight });
    }

    return ok(c, {
      embeddings: Object.fromEntries(updated),
      updatedPairs,
    });
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

  return { app, store };
}
