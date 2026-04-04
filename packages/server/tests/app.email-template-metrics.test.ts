import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { KeywordVector, Person, ScheduleConfig, SchedulePlan } from '@labby/core';
import { createApp } from '../src/app.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

function makeHeaders(token?: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': 'test-request-id',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function login(app: Awaited<ReturnType<typeof createApp>>['app']): Promise<string> {
  const response = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: makeHeaders(),
    body: JSON.stringify({ identity: 'root', password: 'root-pass' }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { access_token: string };
  return payload.access_token;
}

test('template preview, email-task CRUD and metrics API work', async () => {
  const dbPath = createTempDbPath('labby-app-p3');
  const runtime = await createApp({
    db: { dialect: 'sqlite', path: dbPath },
    rootUsername: 'root',
    rootPassword: 'root-pass',
  });

  try {
    const token = await login(runtime.app);

    const previewRes = await runtime.app.request('/api/v1/templates/preview', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({
        templateText: 'Hello {{ user.name }}',
        context: { user: { name: 'Alice' } },
        format: 'markdown',
      }),
    });
    assert.equal(previewRes.status, 200);
    const previewJson = await previewRes.json() as { data: { output: string; errors: unknown[] } };
    assert.equal(previewJson.data.output, 'Hello Alice');
    assert.equal(previewJson.data.errors.length, 0);

    const config: ScheduleConfig = {
      id: 'cfg-1',
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      metadata: {},
    };

    const personA: Person = {
      id: 'p1',
      name: 'A',
      names: { en: 'A' },
      metadata: {},
      keywordIds: ['k1'],
    };
    const personB: Person = {
      id: 'p2',
      name: 'B',
      names: { en: 'B' },
      metadata: {},
      keywordIds: ['k2'],
    };

    const vectorA: KeywordVector = {
      keywordId: 'k1',
      vector64: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
      x: 1,
      y: 0,
      updatedAt: Date.now(),
    };
    const vectorB: KeywordVector = {
      keywordId: 'k2',
      vector64: Array.from({ length: 64 }, (_, i) => (i === 1 ? 1 : 0)),
      x: 0,
      y: 1,
      updatedAt: Date.now(),
    };

    const schedule: SchedulePlan = {
      id: 'plan-1',
      createdAt: Date.now(),
      configId: 'cfg-1',
      sessions: [{ date: '2026-01-05', presentations: [{ presenterId: 'p1', questionerIds: ['p2'] }] }],
    };

    for (const [url, body] of [
      ['/api/v1/db/configs/cfg-1', config],
      ['/api/v1/db/persons/p1', personA],
      ['/api/v1/db/persons/p2', personB],
      ['/api/v1/db/keywords/k1', { id: 'k1', name: 'K1', names: { en: 'K1' }, metadata: {} }],
      ['/api/v1/db/keywords/k2', { id: 'k2', name: 'K2', names: { en: 'K2' }, metadata: {} }],
      ['/api/v1/db/keyword-vectors/k1', vectorA],
      ['/api/v1/db/keyword-vectors/k2', vectorB],
      ['/api/v1/db/schedules/plan-1', schedule],
    ] as const) {
      const response = await runtime.app.request(url, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(body),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    const taskBody = {
      id: 'et-1',
      configId: 'cfg-1',
      daysOfWeek: [1, 3],
      emails: ['x@example.com'],
      recentTimes: 0,
      templateText: 'hello {{recipient}}',
      sentCounts: {},
      metadata: {},
    };

    const putTaskRes = await runtime.app.request('/api/v1/db/email-tasks/et-1', {
      method: 'PUT',
      headers: makeHeaders(token),
      body: JSON.stringify(taskBody),
    });
    assert.ok(putTaskRes.status === 200 || putTaskRes.status === 201);

    const getTaskRes = await runtime.app.request('/api/v1/db/email-tasks/et-1', {
      method: 'GET',
      headers: makeHeaders(token),
    });
    assert.equal(getTaskRes.status, 200);
    const getTaskJson = await getTaskRes.json() as { data: { id: string } };
    assert.equal(getTaskJson.data.id, 'et-1');

    const metricsRes = await runtime.app.request('/api/v1/solver/metrics', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({ scheduleId: 'plan-1' }),
    });
    assert.equal(metricsRes.status, 200);
    const metricsJson = await metricsRes.json() as { data: { metrics: { totalCost: number }; explanations: Array<{ key: string }> } };
    assert.equal(typeof metricsJson.data.metrics.totalCost, 'number');
    assert.ok(metricsJson.data.explanations.some((item) => item.key === 'totalCost'));

    const runRes = await runtime.app.request('/api/v1/solver/run', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({ configId: 'cfg-1', personIds: ['p1', 'p2'] }),
    });
    assert.equal(runRes.status, 200);
    const runJson = await runRes.json() as {
      data: {
        plan: { id: string; sessions: unknown[] };
        metrics: { totalCost: number };
        explanations: Array<{ key: string }>;
      };
    };
    assert.equal(typeof runJson.data.plan.id, 'string');
    assert.equal(typeof runJson.data.metrics.totalCost, 'number');
    assert.ok(runJson.data.explanations.length > 0);

    const incrementalRes = await runtime.app.request('/api/v1/solver/run-incremental', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({
        configId: 'cfg-1',
        previousPlanId: 'plan-1',
        changeDate: '2020-01-01',
        personIds: ['p1', 'p2'],
      }),
    });
    assert.equal(incrementalRes.status, 200);
    const incrementalJson = await incrementalRes.json() as {
      data: {
        startsInclusive: boolean;
        warnings: string[];
        suggestedChangeDate: string;
      };
    };
    assert.equal(incrementalJson.data.startsInclusive, true);
    assert.ok(incrementalJson.data.warnings.length >= 1);
    assert.match(incrementalJson.data.suggestedChangeDate, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await runtime.close();
  }
});
