import { createTestApp, testUuid } from './support/database.js';
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
  const [configId, personAId, personBId, keywordAId, keywordBId, scheduleId, taskId, failingTaskId] =
    ['cfg-1', 'p1', 'p2', 'k1', 'k2', 'plan-1', 'et-1', 'et-fail'].map(testUuid);
  const dbPath = createTempDbPath('labby-app-p3');
  const runtime = await createTestApp({
    db: { dialect: 'pglite', dataDir: dbPath },
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
      id: configId,
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
      id: personAId,
      name: 'A',
      names: { en: 'A' },
      metadata: {},
      keywordIds: [keywordAId],
    };
    const personB: Person = {
      id: personBId,
      name: 'B',
      names: { en: 'B' },
      metadata: {},
      keywordIds: [keywordBId],
    };

    const vectorA: KeywordVector = {
      keywordId: keywordAId,
      embedding: Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0)),
      geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 },
      x: 1,
      y: 0,
      updatedAt: Date.now(),
    };
    const vectorB: KeywordVector = {
      keywordId: keywordBId,
      embedding: Array.from({ length: 8 }, (_, i) => (i === 1 ? 1 : 0)),
      geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 },
      x: 0,
      y: 1,
      updatedAt: Date.now(),
    };

    const schedule: SchedulePlan = {
      id: scheduleId,
      createdAt: Date.now(),
      configId,
      sessions: [{ date: '2026-01-05', presentations: [{ presenterId: personAId, questionerIds: [personBId] }] }],
    };

    for (const [url, body] of [
      [`/api/v1/db/configs/${configId}`, config],
      [`/api/v1/db/persons/${personAId}`, personA],
      [`/api/v1/db/persons/${personBId}`, personB],
      [`/api/v1/db/keywords/${keywordAId}`, { id: keywordAId, name: 'K1', names: { en: 'K1' }, metadata: {} }],
      [`/api/v1/db/keywords/${keywordBId}`, { id: keywordBId, name: 'K2', names: { en: 'K2' }, metadata: {} }],
      [`/api/v1/db/keyword-vectors/${keywordAId}`, vectorA],
      [`/api/v1/db/keyword-vectors/${keywordBId}`, vectorB],
      [`/api/v1/db/schedules/${scheduleId}`, schedule],
    ] as const) {
      const response = await runtime.app.request(url, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(body),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    const taskBody = {
      id: taskId,
      configId,
      daysOfWeek: [1, 3],
      emails: ['x@example.com'],
      recentTimes: 0,
      templateText: 'hello {{recipient}}',
      sentCounts: {},
      metadata: {},
    };

    const putTaskRes = await runtime.app.request(`/api/v1/db/email-tasks/${taskId}`, {
      method: 'PUT',
      headers: makeHeaders(token),
      body: JSON.stringify(taskBody),
    });
    assert.ok(putTaskRes.status === 200 || putTaskRes.status === 201);

    const getTaskRes = await runtime.app.request(`/api/v1/db/email-tasks/${taskId}`, {
      method: 'GET',
      headers: makeHeaders(token),
    });
    assert.equal(getTaskRes.status, 200);
    const getTaskJson = await getTaskRes.json() as { data: { id: string } };
    assert.equal(getTaskJson.data.id, taskId);

    const failingRuntime = await createTestApp({
      db: { dialect: 'pglite', dataDir: createTempDbPath('labby-app-send-now-fail') },
      rootUsername: 'root',
      rootPassword: 'root-pass',
      runEmailTaskNow: async () => {
        throw new Error('template render failed');
      },
    });
    try {
      const failingToken = await login(failingRuntime.app);
      const failingTaskRes = await failingRuntime.app.request(`/api/v1/db/email-tasks/${failingTaskId}`, {
        method: 'PUT',
        headers: makeHeaders(failingToken),
        body: JSON.stringify({ ...taskBody, id: failingTaskId }),
      });
      assert.ok(failingTaskRes.status === 200 || failingTaskRes.status === 201);
      const sendNowRes = await failingRuntime.app.request(`/api/v1/db/email-tasks/${failingTaskId}/send-now`, {
        method: 'POST',
        headers: makeHeaders(failingToken),
      });
      assert.equal(sendNowRes.status, 400);
      const sendNowJson = await sendNowRes.json() as { message: string };
      assert.match(sendNowJson.message, /template render failed/);
    } finally {
      await failingRuntime.close();
    }

    const metricsRes = await runtime.app.request('/api/v1/solver/metrics', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({ scheduleId }),
    });
    assert.equal(metricsRes.status, 200);
    const metricsJson = await metricsRes.json() as { data: { metrics: { totalCost: number }; explanations: Array<{ key: string }> } };
    assert.equal(typeof metricsJson.data.metrics.totalCost, 'number');
    assert.ok(metricsJson.data.explanations.some((item) => item.key === 'totalCost'));

    const runRes = await runtime.app.request('/api/v1/solver/run', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({ configId, personIds: [personAId, personBId] }),
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
        configId,
        previousPlanId: scheduleId,
        changeDate: '2020-01-01',
        personIds: [personAId, personBId],
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
