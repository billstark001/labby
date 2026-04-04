import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { logger } from "hono/logger";
import { z } from "zod";

import type {
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
} from "@labby/core";
import {
  solveFull,
  solveIncremental,
  keywordVectorsToSimilarityLookup,
} from "@labby/core";

import { AuthService, UserRole, resolvePasetoKey } from "./lib/auth.js";
import { EmbeddingService } from "./lib/embedding-service.js";
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

export async function createApp(options: CreateAppOptions): Promise<{ app: Hono; store: SqliteStore; close: () => Promise<void>; }> {
  const dbConfig = options.db ?? { dialect: "sqlite", path: options.dbPath ?? "./run/labby.db" };
  if (dbConfig.dialect === "sqlite") {
    fs.mkdirSync(path.dirname(dbConfig.path), { recursive: true });
  }

  const store = new SqliteStore(dbConfig);
  const embeddingService = new EmbeddingService(store);
  await embeddingService.start();
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
    embeddingService.invalidate();
    return ok(c, await store.getKeyword(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/keywords/:id", async (c) => {
    await store.deleteKeyword(c.req.param("id"));
    embeddingService.invalidate();
    return c.body(null, 204);
  });

  app.get("/api/v1/db/keyword-vectors", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listKeywordVectors(), offset, limit));
  });
  app.get("/api/v1/db/keyword-vectors/:keywordId", async (c) => {
    return ok(c, (await store.getKeywordVector(c.req.param("keywordId"))) ?? null);
  });
  app.put("/api/v1/db/keyword-vectors/:keywordId", async (c) => {
    const vector = await c.req.json<KeywordVector>();
    await store.putKeywordVector({ ...vector, keywordId: c.req.param("keywordId") });
    embeddingService.invalidate();
    return ok(c, await store.getKeywordVector(c.req.param("keywordId")), 201);
  });
  app.delete("/api/v1/db/keyword-vectors/:keywordId", async (c) => {
    await store.deleteKeywordVector(c.req.param("keywordId"));
    embeddingService.invalidate();
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
    const vectors = await store.listKeywordVectors();
    const unavailabilities = await store.listUnavailabilities();

    const similarityLookup = keywordVectorsToSimilarityLookup(vectors);

    const plan = solveFull({ persons, similarities: similarityLookup, config, unavailabilities });
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
    const vectors = await store.listKeywordVectors();
    const unavailabilities = await store.listUnavailabilities();

    const similarityLookup = keywordVectorsToSimilarityLookup(vectors);

    const plan = solveIncremental({
      persons,
      similarities: similarityLookup,
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
    margin: z.number().positive().optional(),
    learningRate: z.number().optional(),
  });

  const pairUpdateSchema = z.object({
    leftId: z.string().min(1),
    rightId: z.string().min(1),
    targetDistance: z.number().nonnegative(),
    learningRate: z.number().optional(),
  });

  const tripletRecommendSchema = z.object({
    excludedPairs: z.array(z.string().min(3)).optional(),
  });

  const supervisionSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pair'),
      leftId: z.string().min(1),
      rightId: z.string().min(1),
      targetDistance: z.number().nonnegative(),
      learningRate: z.number().optional(),
    }),
    z.object({
      kind: z.literal('ranked'),
      anchorId: z.string().min(1),
      orderedIds: z.array(z.string().min(1)).min(2),
      margin: z.number().positive().optional(),
      learningRate: z.number().optional(),
    }),
  ]);

  app.post("/api/v1/nlp/recommend-triplet", async (c) => {
    const body = tripletRecommendSchema.parse(await c.req.json());
    const query = await embeddingService.recommendTriplet(body.excludedPairs ?? []);
    return ok(c, {
      query,
    });
  });

  app.post('/api/v1/nlp/apply-supervision', async (c) => {
    const query = supervisionSchema.parse(await c.req.json());
    try {
      const result = await embeddingService.applySupervision(query);
      return ok(c, result);
    } catch {
      throw new AppError('VALIDATION_ERROR', 'supervision ids not found', 400);
    }
  });

  app.post("/api/v1/nlp/update-similarity", async (c) => {
    const body = tripletUpdateSchema.parse(await c.req.json());
    let updatedVectors: KeywordVector[];
    let loss: number;
    try {
      const result = await embeddingService.updateTriplet(
        body.anchorId,
        body.positiveId,
        body.negativeId,
        body.margin ?? 0.2,
        body.learningRate ?? 0.05,
      );
      loss = result.loss;
      updatedVectors = result.updatedVectors;
    } catch {
      throw new AppError("VALIDATION_ERROR", "triplet ids not found", 400);
    }

    return ok(c, {
      loss,
      updatedVectors,
    });
  });

  app.post("/api/v1/nlp/update-pair", async (c) => {
    const body = pairUpdateSchema.parse(await c.req.json());
    let updatedVectors: KeywordVector[];
    let loss: number;
    try {
      const result = await embeddingService.updatePair(
        body.leftId,
        body.rightId,
        body.targetDistance,
        body.learningRate ?? 0.05,
      );
      loss = result.loss;
      updatedVectors = result.updatedVectors;
    } catch {
      throw new AppError("VALIDATION_ERROR", "pair ids not found", 400);
    }

    return ok(c, {
      loss,
      updatedVectors,
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

  return {
    app,
    store,
    close: async () => {
      await embeddingService.shutdown();
      await store.close();
    },
  };
}
