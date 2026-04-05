import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { logger } from "hono/logger";
import { z } from "zod";

import type {
  EmailTask,
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
} from "@labby/core";
import {
  buildScheduleIcs,
  computeScheduleMetrics,
  explainScheduleMetrics,
  renderTemplate,
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
import {
  defaultDisplayName,
  defaultIncrementalDate,
  parsePagination,
  toPage,
} from "./lib/app-helpers.js";
import {
  backupActionSchema,
  issueUserBodySchema,
  loginBodySchema,
  pairUpdateSchema,
  refreshBodySchema,
  solverIncrementalInputSchema,
  solverInputSchema,
  solverMetricsInputSchema,
  supervisionSchema,
  templatePreviewSchema,
  tripletRecommendSchema,
  tripletUpdateSchema,
} from "./lib/app-schemas.js";
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
  enablePublicEmailTaskIcs?: boolean;
  onEmailTasksChanged?: () => Promise<void> | void;
  runEmailTaskNow?: (taskId: string) => Promise<void>;
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

  const app = new Hono();

  if (options.enableLogger ?? true) {
    app.use("*", logger());
  }
  app.use("/api/v1/*", requireRequestId);
  app.use("/api/v1/db/*", requireClientAuth(authService));
  app.use("/api/v1/solver/*", requireClientAuth(authService));
  app.use("/api/v1/nlp/*", requireClientAuth(authService));
  app.use("/api/v1/templates/*", requireClientAuth(authService));
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
  app.use("/api/v1/templates/*", requireMinRole(UserRole.Admin));
  app.use("/api/v1/system/backup/*", requireMinRole(UserRole.Admin));

  app.get("/health", (c) => c.json({ ok: true, now: Date.now() }));

  if (options.enablePublicEmailTaskIcs) {
    app.get('/public/email-tasks/:id/schedule.ics', async (c) => {
      const taskId = c.req.param('id');
      const task = await store.getEmailTask(taskId);
      const shouldServeIcs = Boolean(task?.metadata && (task.metadata as Record<string, unknown>).serveScheduleIcs === true);
      if (!task || !shouldServeIcs) {
        throw new AppError('VALIDATION_ERROR', 'schedule ics not found', 404);
      }

      const latest = (await store.listSchedules())
        .filter((item) => item.configId === task.configId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      if (!latest) {
        throw new AppError('VALIDATION_ERROR', 'schedule ics not found', 404);
      }

      const config = await store.getConfig(task.configId);
      const personMap = new Map((await store.listPersons()).map((person) => [person.id, person]));
      const ics = buildScheduleIcs(latest, personMap, defaultDisplayName, config ?? undefined);

      c.header('Content-Type', 'text/calendar; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      c.header('Content-Disposition', `inline; filename="labby-schedule-${taskId}.ics"`);
      return c.body(ics);
    });
  }

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
        canManageUsers: session.role >= UserRole.Root,
      },
    });
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

  app.patch("/api/v1/users/:id", requireMinRole(UserRole.Admin), async (c) => {
    const session = getAuthSession(c);
    const id = c.req.param("id");
    const target = await store.getUserById(id);
    if (!target) {
      throw new AppError("VALIDATION_ERROR", "user not found", 404);
    }
    // Admin can only update User-role users; Root can update anyone
    if (session.role < UserRole.Root && target.role >= UserRole.Admin) {
      throw new AppError("AUTH_FORBIDDEN", "insufficient permissions to update this user", 403);
    }
    const body = await c.req.json<{ role?: number; disabled?: boolean }>();
    const updated = { ...target };
    if (body.role !== undefined) {
      const newRole = Number(body.role);
      // Cannot elevate beyond own role
      if (newRole > session.role) {
        throw new AppError("AUTH_FORBIDDEN", "cannot grant a role higher than your own", 403);
      }
      updated.role = newRole as typeof updated.role;
    }
    if (body.disabled !== undefined) {
      updated.disabled = Boolean(body.disabled);
    }
    await store.updateUser(updated);
    const { passwordHash: _, ...safeUser } = updated;
    return ok(c, safeUser);
  });

  app.delete("/api/v1/users/:id", requireMinRole(UserRole.Root), async (c) => {
    const id = c.req.param("id");
    const target = await store.getUserById(id);
    if (!target) {
      throw new AppError("VALIDATION_ERROR", "user not found", 404);
    }
    await store.deleteUser(id);
    return c.body(null, 204);
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

  app.get("/api/v1/db/constraints", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listConstraints(), offset, limit));
  });
  app.get("/api/v1/db/constraints/:id", async (c) => ok(c, (await store.getConstraint(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/constraints/:id", async (c) => {
    const constraint = await c.req.json<ScheduleConstraint>();
    await store.putConstraint({ ...constraint, id: c.req.param("id") });
    return ok(c, await store.getConstraint(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/constraints/:id", async (c) => {
    await store.deleteConstraint(c.req.param("id"));
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

  app.get("/api/v1/db/email-tasks", async (c) => {
    const { offset, limit } = parsePagination(c.req.query());
    return ok(c, toPage(await store.listEmailTasks(), offset, limit));
  });
  app.get("/api/v1/db/email-tasks/:id", async (c) => ok(c, (await store.getEmailTask(c.req.param("id"))) ?? null));
  app.put("/api/v1/db/email-tasks/:id", async (c) => {
    const task = await c.req.json<EmailTask>();
    await store.putEmailTask({ ...task, id: c.req.param("id") });
    await options.onEmailTasksChanged?.();
    return ok(c, await store.getEmailTask(c.req.param("id")), 201);
  });
  app.delete("/api/v1/db/email-tasks/:id", async (c) => {
    await store.deleteEmailTask(c.req.param("id"));
    await options.onEmailTasksChanged?.();
    return c.body(null, 204);
  });
  app.post('/api/v1/db/email-tasks/:id/send-now', async (c) => {
    const taskId = c.req.param('id');
    const task = await store.getEmailTask(taskId);
    if (!task) {
      throw new AppError('VALIDATION_ERROR', 'email task not found', 404);
    }
    if (!options.runEmailTaskNow) {
      throw new AppError('INTERNAL_ERROR', 'email sender is not configured on server', 503);
    }
    await options.runEmailTaskNow(taskId);
    return ok(c, { ok: true });
  });
  app.post('/api/v1/db/email-tasks/:id/skip-next', async (c) => {
    const taskId = c.req.param('id');
    const task = await store.getEmailTask(taskId);
    if (!task) {
      throw new AppError('VALIDATION_ERROR', 'email task not found', 404);
    }

    const body = await c.req.json().catch(() => ({})) as { skip?: unknown };
    const skip = typeof body.skip === 'boolean' ? body.skip : true;

    const updated: EmailTask = {
      ...task,
      skipNextRun: skip,
      modifiedAt: Date.now(),
    };

    await store.putEmailTask(updated);
    await options.onEmailTasksChanged?.();
    return ok(c, updated);
  });

  // ---------------------------------------------------------------------------
  // Solver routes (call @labby/core)
  // ---------------------------------------------------------------------------

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
    const constraints = await store.listConstraintsByConfig(config.id);

    const similarityLookup = keywordVectorsToSimilarityLookup(vectors);

    const plan = solveFull({
      persons,
      similarities: similarityLookup,
      config,
      unavailabilities,
      constraints,
    });
    const metrics = computeScheduleMetrics(plan, {
      persons,
      similarities: similarityLookup,
      config,
      unavailabilities,
      constraints,
    });
    return ok(c, {
      plan,
      metrics,
      explanations: explainScheduleMetrics(metrics),
      warnings: [] as string[],
    });
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
    const constraints = await store.listConstraintsByConfig(config.id);

    const similarityLookup = keywordVectorsToSimilarityLookup(vectors);

    const warnings: string[] = [];
    const suggestedDate = defaultIncrementalDate();
    if (body.changeDate < suggestedDate) {
      warnings.push(`changeDate ${body.changeDate} is earlier than suggested default ${suggestedDate}`);
    }

    const plan = solveIncremental({
      persons,
      similarities: similarityLookup,
      config,
      unavailabilities,
      previousPlan,
      changeDate: body.changeDate,
      constraints,
    });
    const metrics = computeScheduleMetrics(plan, {
      persons,
      similarities: similarityLookup,
      config,
      unavailabilities,
      constraints,
    });
    return ok(c, {
      plan,
      metrics,
      explanations: explainScheduleMetrics(metrics),
      warnings,
      startsInclusive: true,
      suggestedChangeDate: suggestedDate,
    });
  });

  app.post("/api/v1/solver/metrics", async (c) => {
    const body = solverMetricsInputSchema.parse(await c.req.json());
    const plan = await store.getSchedule(body.scheduleId);
    if (!plan) throw new AppError("VALIDATION_ERROR", "schedule not found", 404);
    const config = await store.getConfig(plan.configId);
    if (!config) throw new AppError("VALIDATION_ERROR", "config not found", 404);

    const persons = await store.listPersons();
    const vectors = await store.listKeywordVectors();
    const unavailabilities = await store.listUnavailabilities();
    const constraints = await store.listConstraintsByConfig(config.id);
    const similarityLookup = keywordVectorsToSimilarityLookup(vectors);

    if (!body.sessionDate) {
      const metrics = computeScheduleMetrics(plan, {
        persons,
        similarities: similarityLookup,
        config,
        unavailabilities,
        constraints,
      });
      return ok(c, { metrics, explanations: explainScheduleMetrics(metrics) });
    }

    const sessionIndex = plan.sessions.findIndex((s) => s.date === body.sessionDate);
    if (sessionIndex < 0) {
      throw new AppError("VALIDATION_ERROR", "session date not found in schedule", 404);
    }

    const sessionOnlyPlan: SchedulePlan = {
      ...plan,
      sessions: [plan.sessions[sessionIndex]],
    };

    const historical = plan.sessions.slice(0, sessionIndex);
    const metrics = computeScheduleMetrics(sessionOnlyPlan, {
      persons,
      similarities: similarityLookup,
      config,
      unavailabilities,
      constraints,
    }, historical);

    return ok(c, {
      metrics,
      explanations: explainScheduleMetrics(metrics),
      scope: {
        scheduleId: body.scheduleId,
        sessionDate: body.sessionDate,
      },
    });
  });

  app.post('/api/v1/templates/preview', async (c) => {
    const body = templatePreviewSchema.parse(await c.req.json());
    const result = renderTemplate(body.templateText, {
      ...body.context,
      language: body.language ?? (body.context.language as string | undefined) ?? 'en',
    }, {
      format: body.format,
    });
    return ok(c, result);
  });

  // ---------------------------------------------------------------------------
  // NLP / embedding routes (call @labby/core)
  // ---------------------------------------------------------------------------

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
        body.updateOptions,
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
        body.updateOptions,
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
