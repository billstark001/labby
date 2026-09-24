import { createTestApp, testUuid } from './support/database.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { EmailTask, Person, ScheduleConfig, SchedulePlan } from '@labby/core';
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

test('public email task ICS endpoint is available when a task opts in', async () => {
  const [configId, personAId, personBId, scheduleId, taskId] =
    ['cfg-ics', 'p1', 'p2', 'plan-ics', 'task-ics'].map(testUuid);
  const runtime = await createTestApp({
    db: { dialect: 'pglite', dataDir: createTempDbPath('labby-public-ics') },
    rootUsername: 'root',
    rootPassword: 'root-pass',
  });

  try {
    const token = await login(runtime.app);

    const config: ScheduleConfig = {
      id: configId,
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      timezone: 'Asia/Tokyo',
      metadata: {},
    };

    const personA: Person = {
      id: personAId,
      name: 'Alice',
      names: { en: 'Alice' },
      metadata: {},
      keywordIds: [],
    };

    const personB: Person = {
      id: personBId,
      name: 'Bob',
      names: { en: 'Bob' },
      metadata: {},
      keywordIds: [],
    };

    const schedule: SchedulePlan = {
      id: scheduleId,
      createdAt: Date.now(),
      configId,
      sessions: [
        {
          date: '2026-01-05',
          presentations: [{ presenterId: personAId, questionerIds: [personBId] }],
        },
      ],
    };

    const task: EmailTask = {
      id: taskId,
      configId,
      daysOfWeek: [1],
      emails: ['a@example.com'],
      recentTimes: 0,
      templateText: 'hello',
      metadata: {
        serveScheduleIcs: true,
      },
    };

    for (const [url, body] of [
      [`/api/v1/db/configs/${configId}`, config],
      [`/api/v1/db/persons/${personAId}`, personA],
      [`/api/v1/db/persons/${personBId}`, personB],
      [`/api/v1/db/schedules/${scheduleId}`, schedule],
      [`/api/v1/db/email-tasks/${taskId}`, task],
    ] as const) {
      const response = await runtime.app.request(url, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(body),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    const icsRes = await runtime.app.request(`/public/email-tasks/${taskId}/schedule.ics`);
    assert.equal(icsRes.status, 200);
    assert.equal(icsRes.headers.get('content-type')?.includes('text/calendar'), true);

    const icsBody = await icsRes.text();
    assert.match(icsBody, /BEGIN:VCALENDAR/);
    assert.match(icsBody, /BEGIN:VEVENT/);
    assert.match(icsBody, /DTSTART:20260105T000000Z/);
    assert.match(icsBody, /DTEND:20260105T010000Z/);
    assert.match(icsBody, /SUMMARY:Presenter: Alice/);

    await runtime.app.request(`/api/v1/db/email-tasks/${taskId}`, {
      method: 'PUT',
      headers: makeHeaders(token),
      body: JSON.stringify({ ...task, metadata: { serveScheduleIcs: false } }),
    });

    const disabledRes = await runtime.app.request(`/public/email-tasks/${taskId}/schedule.ics`);
    assert.equal(disabledRes.status, 404);
  } finally {
    await runtime.close();
  }
});
