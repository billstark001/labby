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

test('public email task ICS endpoint is available only when enabled and task opts in', async () => {
  const runtime = await createApp({
    db: { dialect: 'sqlite', path: createTempDbPath('labby-public-ics') },
    rootUsername: 'root',
    rootPassword: 'root-pass',
    enablePublicEmailTaskIcs: true,
  });

  try {
    const token = await login(runtime.app);

    const config: ScheduleConfig = {
      id: 'cfg-ics',
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
      name: 'Alice',
      names: { en: 'Alice' },
      metadata: {},
      keywordIds: [],
    };

    const personB: Person = {
      id: 'p2',
      name: 'Bob',
      names: { en: 'Bob' },
      metadata: {},
      keywordIds: [],
    };

    const schedule: SchedulePlan = {
      id: 'plan-ics',
      createdAt: Date.now(),
      configId: 'cfg-ics',
      sessions: [
        {
          date: '2026-01-05',
          presentations: [{ presenterId: 'p1', questionerIds: ['p2'] }],
        },
      ],
    };

    const task: EmailTask = {
      id: 'task-ics',
      configId: 'cfg-ics',
      daysOfWeek: [1],
      emails: ['a@example.com'],
      recentTimes: 0,
      templateText: 'hello',
      metadata: {
        serveScheduleIcs: true,
      },
    };

    for (const [url, body] of [
      ['/api/v1/db/configs/cfg-ics', config],
      ['/api/v1/db/persons/p1', personA],
      ['/api/v1/db/persons/p2', personB],
      ['/api/v1/db/schedules/plan-ics', schedule],
      ['/api/v1/db/email-tasks/task-ics', task],
    ] as const) {
      const response = await runtime.app.request(url, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(body),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    const icsRes = await runtime.app.request('/public/email-tasks/task-ics/schedule.ics');
    assert.equal(icsRes.status, 200);
    assert.equal(icsRes.headers.get('content-type')?.includes('text/calendar'), true);

    const icsBody = await icsRes.text();
    assert.match(icsBody, /BEGIN:VCALENDAR/);
    assert.match(icsBody, /BEGIN:VEVENT/);
    assert.match(icsBody, /SUMMARY:Presenter: Alice/);

    await runtime.app.request('/api/v1/db/email-tasks/task-ics', {
      method: 'PUT',
      headers: makeHeaders(token),
      body: JSON.stringify({ ...task, metadata: { serveScheduleIcs: false } }),
    });

    const disabledRes = await runtime.app.request('/public/email-tasks/task-ics/schedule.ics');
    assert.equal(disabledRes.status, 404);
  } finally {
    await runtime.close();
  }
});
