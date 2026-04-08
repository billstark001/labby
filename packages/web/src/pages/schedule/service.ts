import { nanoid } from 'nanoid';
import {
  computeScheduleMetrics,
  explainScheduleMetrics,
  solveFull,
  solveIncremental,
} from '@labby/core';
import type {
  Person,
  ScheduleConfig,
  ScheduleConstraint,
  SchedulePlan,
  PersonUnavailability,
  MetricExplanation,
  ScheduleMetrics,
  SimilarityLookup,
} from '@labby/core';
import * as api from '@/api-server/schedule';
import { isServerDeployment } from '@/lib/runtime';

// ─── Pure utilities ──────────────────────────────────────────────────────────

export function defaultIncrementalDate(): string {
  const nextWeek = new Date();
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  return nextWeek.toISOString().slice(0, 10);
}

export function normalizeSolveResponse(result: unknown): {
  plan: SchedulePlan;
  metrics?: ScheduleMetrics;
  explanations?: MetricExplanation[];
  warnings?: string[];
} {
  if (result && typeof result === 'object' && 'plan' in (result as Record<string, unknown>)) {
    return result as {
      plan: SchedulePlan;
      metrics?: ScheduleMetrics;
      explanations?: MetricExplanation[];
      warnings?: string[];
    };
  }
  return { plan: result as SchedulePlan };
}

export function buildSessionDateMeta(
  sessions: SchedulePlan['sessions'],
  mutations: SchedulePlan['sessionMutations'],
  existing: SchedulePlan['sessionDateMeta'],
): NonNullable<SchedulePlan['sessionDateMeta']> {
  const existingMap = existing ?? {};
  const insertMap = new Map<string, { action: 'insert' | 'delete'; createdAt: number }>();
  for (const m of mutations ?? []) {
    if (m.action === 'insert') {
      insertMap.set(m.date, { action: m.action, createdAt: m.createdAt });
    }
  }

  const out: NonNullable<SchedulePlan['sessionDateMeta']> = {};
  for (const session of sessions) {
    const meta = existingMap[session.date] ?? insertMap.get(session.date);
    if (meta) {
      out[session.date] = meta;
    }
  }
  return out;
}

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * All locally-available data needed to run solver or metrics operations.
 * The server backend only consumes a subset (ids), but the uniform signature
 * means the component never needs to know which backend is active.
 */
export interface SolverContext {
  persons: Person[];
  similarities: SimilarityLookup;
  unavailabilities: PersonUnavailability[];
  constraints: ScheduleConstraint[];
}

export interface MetricsResult {
  metrics: ScheduleMetrics;
  explanations: MetricExplanation[];
}

// ─── Backend interface ────────────────────────────────────────────────────────

/**
 * Abstracts the two deployment modes:
 *   - LocalSolverBackend  – runs the solver directly in-process (browser/WASM).
 *   - ServerSolverBackend – delegates every call to the HTTP API; ctx fields
 *                           not required by the server are intentionally ignored.
 */
export interface ISolverBackend {
  runFull(
    config: ScheduleConfig,
    ctx: SolverContext,
  ): Promise<unknown>;

  runIncremental(
    config: ScheduleConfig,
    currentPlan: SchedulePlan,
    changeDate: string,
    ctx: SolverContext,
  ): Promise<unknown>;

  computeMetricsForPlan(
    plan: SchedulePlan,
    config: ScheduleConfig,
    ctx: SolverContext,
  ): Promise<MetricsResult>;

  computeMetricsForSession(
    plan: SchedulePlan,
    sessionDate: string,
    config: ScheduleConfig,
    ctx: SolverContext,
  ): Promise<MetricsResult>;
}

// ─── Local (in-browser) implementation ───────────────────────────────────────

export class LocalSolverBackend implements ISolverBackend {
  async runFull(config: ScheduleConfig, ctx: SolverContext): Promise<unknown> {
    return {
      plan: {
        id: nanoid(),
        createdAt: Date.now(),
        configId: config.id,
        sessions: solveFull({
          persons: ctx.persons,
          similarities: ctx.similarities,
          config,
          unavailabilities: ctx.unavailabilities,
          constraints: ctx.constraints,
        }),
      } satisfies SchedulePlan,
    };
  }

  async runIncremental(
    config: ScheduleConfig,
    currentPlan: SchedulePlan,
    changeDate: string,
    ctx: SolverContext,
  ): Promise<unknown> {
    return {
      plan: {
        id: nanoid(),
        createdAt: Date.now(),
        configId: config.id,
        sessions: solveIncremental({
          persons: ctx.persons,
          similarities: ctx.similarities,
          config,
          sessions: currentPlan.sessions,
          mutations: currentPlan.sessionMutations,
          changeDate,
          unavailabilities: ctx.unavailabilities,
          constraints: ctx.constraints,
        }),
        sessionMutations: currentPlan.sessionMutations,
      } satisfies SchedulePlan,
    };
  }

  async computeMetricsForPlan(
    plan: SchedulePlan,
    config: ScheduleConfig,
    ctx: SolverContext,
  ): Promise<MetricsResult> {
    const metrics = computeScheduleMetrics(plan, {
      persons: ctx.persons,
      similarities: ctx.similarities,
      config,
      unavailabilities: ctx.unavailabilities,
      constraints: ctx.constraints,
    });
    return { metrics, explanations: explainScheduleMetrics(metrics) };
  }

  async computeMetricsForSession(
    plan: SchedulePlan,
    sessionDate: string,
    config: ScheduleConfig,
    ctx: SolverContext,
  ): Promise<MetricsResult> {
    const sessionIndex = plan.sessions.findIndex(s => s.date === sessionDate);
    if (sessionIndex < 0) throw new Error(`Session not found: ${sessionDate}`);
    const metrics = computeScheduleMetrics(
      { ...plan, sessions: [plan.sessions[sessionIndex]] },
      {
        persons: ctx.persons,
        similarities: ctx.similarities,
        config,
        unavailabilities: ctx.unavailabilities,
        constraints: ctx.constraints,
      },
      plan.sessions.slice(0, sessionIndex),
    );
    return { metrics, explanations: explainScheduleMetrics(metrics) };
  }
}

// ─── Server (HTTP API) implementation ────────────────────────────────────────

export class ServerSolverBackend implements ISolverBackend {
  async runFull(config: ScheduleConfig, ctx: SolverContext): Promise<unknown> {
    return await api.runFull(
      config,
      ctx.persons.map(p => p.id),
    )
  }

  async runIncremental(
    config: ScheduleConfig,
    currentPlan: SchedulePlan,
    changeDate: string,
    ctx: SolverContext,
  ): Promise<unknown> {
    return await api.runIncremental(
      config,
      currentPlan,
      changeDate,
      ctx.persons.map(p => p.id),
    );
  }

  async computeMetricsForPlan(
    plan: SchedulePlan,
    _config: ScheduleConfig,
    _ctx: SolverContext,
  ): Promise<MetricsResult> {
    return await api.computeMetricsForPlan(plan);
  }

  async computeMetricsForSession(
    plan: SchedulePlan,
    sessionDate: string,
    _config: ScheduleConfig,
    _ctx: SolverContext,
  ): Promise<MetricsResult> {
    return await api.computeMetricsForSession(plan, sessionDate);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSolverBackend(): ISolverBackend {
  return isServerDeployment ? new ServerSolverBackend() : new LocalSolverBackend();
}