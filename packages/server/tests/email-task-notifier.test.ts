import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Mailer } from '../src/lib/mailer.js';
import { EmailTaskNotifier } from '../src/cron/email-task-notifier.js';
import { SqliteStore } from '../src/store/index.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

class FakeScheduler {
  private readonly defs = new Map<string, { handler: () => Promise<void> | void }>();

  register(def: { name: string; handler: () => Promise<void> | void }): { name: string; stop: () => void } {
    this.defs.set(def.name, { handler: def.handler });
    return { name: def.name, stop: () => this.unregister(def.name) };
  }

  unregister(name: string): void {
    this.defs.delete(name);
  }

  get registeredJobs(): string[] {
    return [...this.defs.keys()];
  }
}

test('EmailTaskNotifier syncs jobs and sends per-recipient with independent counters', async () => {
  const dbPath = createTempDbPath('labby-email-task');
  const store = new SqliteStore({ dialect: 'sqlite', path: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string; attachments?: Array<{ filename: string }> }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string; attachments?: Array<{ filename: string }> }) => {
      sent.push({ to: input.to, text: input.text, attachments: input.attachments });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-1',
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2099-01-01',
      endDate: '2099-01-31',
      metadata: {},
    });

    await store.putSchedule({
      id: 'plan-1',
      createdAt: Date.now(),
      configId: 'cfg-1',
      sessions: [{ date: '2099-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: 'task-1',
      configId: 'cfg-1',
      daysOfWeek: [1, 3],
      emails: ['a@example.com', 'b@example.com'],
      recentTimes: 1,
      templateText: 'Hi {{ recipient }} / {{ sessionCount }}',
      sentCounts: { 'a@example.com': 1 },
      metadata: {},
    });

    const notifier = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
    });

    await notifier.syncJobs();
    assert.ok(scheduler.registeredJobs.includes('email-task:task-1'));

    await notifier.runTask('task-1');

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.to, ['b@example.com']);
    assert.ok((sent[0]?.text ?? '').includes('b@example.com'));
    assert.equal(sent[0]?.attachments?.length, 2);
    assert.ok(sent[0]?.attachments?.some((item) => item.filename.endsWith('.csv')));
    assert.ok(sent[0]?.attachments?.some((item) => item.filename.endsWith('.ics')));

    const updated = await store.getEmailTask('task-1');
    assert.equal(updated?.sentCounts?.['a@example.com'], 1);
    assert.equal(updated?.sentCounts?.['b@example.com'], 1);
    assert.equal(typeof updated?.lastRunAt, 'number');
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier skips scheduled delivery when no new schedule is generated', async () => {
  const dbPath = createTempDbPath('labby-email-task-stale');
  const store = new SqliteStore({ dialect: 'sqlite', path: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[] }> = [];

  const mailer = {
    send: async (input: { to: string[] }) => {
      sent.push({ to: input.to });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-stale',
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2026-01-01',
      endDate: '2099-01-31',
      metadata: {},
    });

    await store.putSchedule({
      id: 'plan-stale',
      createdAt: Date.now(),
      configId: 'cfg-stale',
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: 'task-stale',
      configId: 'cfg-stale',
      daysOfWeek: [1],
      emails: ['stale@example.com'],
      recentTimes: 0,
      templateText: 'Hi {{ recipient }}',
      metadata: {},
    });

    const notifier = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
    });

    await notifier.runTask('task-stale');
    await notifier.runTask('task-stale');

    assert.equal(sent.length, 1);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier invalidates jobs when config period already ended', async () => {
  const dbPath = createTempDbPath('labby-email-task-ended');
  const store = new SqliteStore({ dialect: 'sqlite', path: dbPath });
  const scheduler = new FakeScheduler();

  const mailer = {
    send: async () => {},
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-ended',
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2020-01-01',
      endDate: '2020-12-31',
      metadata: {},
    });

    await store.putEmailTask({
      id: 'task-ended',
      configId: 'cfg-ended',
      daysOfWeek: [1],
      emails: ['ended@example.com'],
      recentTimes: 0,
      templateText: 'x',
      metadata: {},
    });

    const notifier = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
    });

    await notifier.syncJobs();
    assert.deepEqual(scheduler.registeredJobs, []);
  } finally {
    await store.close();
  }
});
