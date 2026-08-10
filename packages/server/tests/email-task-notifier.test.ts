import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Mailer } from '../src/lib/mailer.js';
import { EmailTaskNotifier } from '../src/cron/email-task-notifier.js';
import { LabbyStore } from '../src/store/index.js';

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
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
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

test('EmailTaskNotifier sends scheduled delivery on every matching run', async () => {
  const dbPath = createTempDbPath('labby-email-task-stale');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
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

    assert.equal(sent.length, 2);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier consumes skip-next once after manual send, even without newer schedule', async () => {
  const dbPath = createTempDbPath('labby-email-task-skip-next-once');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[] }> = [];

  const mailer = {
    send: async (input: { to: string[] }) => {
      sent.push({ to: input.to });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-skip-next',
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
      id: 'plan-skip-next',
      createdAt: Date.now(),
      configId: 'cfg-skip-next',
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: 'task-skip-next',
      configId: 'cfg-skip-next',
      daysOfWeek: [1],
      emails: ['skip-next@example.com'],
      recentTimes: 0,
      templateText: 'Hi {{ recipient }}',
      skipNextRun: true,
      metadata: {},
    });

    const notifier = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
    });

    // Manual run should send immediately and keep skip-next for the next scheduled run.
    await notifier.runTaskNow('task-skip-next');
    assert.equal(sent.length, 1);

    // First scheduled run consumes skip-next and should not send.
    await notifier.runTask('task-skip-next');
    assert.equal(sent.length, 1);
    const afterFirstScheduled = await store.getEmailTask('task-skip-next');
    assert.equal(afterFirstScheduled?.skipNextRun, false);
    assert.equal(typeof afterFirstScheduled?.lastSkippedAt, 'number');

    // Later scheduled runs can send again once skip-next has been consumed.
    await notifier.runTask('task-skip-next');
    assert.equal(sent.length, 2);
    const afterSecondScheduled = await store.getEmailTask('task-skip-next');
    assert.equal(afterSecondScheduled?.skipNextRun, false);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier invalidates jobs when config period already ended', async () => {
  const dbPath = createTempDbPath('labby-email-task-ended');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
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

test('EmailTaskNotifier skips disabled scheduled runs but allows manual send with sender name template', async () => {
  const dbPath = createTempDbPath('labby-email-task-disabled-manual');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; fromName?: string }> = [];

  const mailer = {
    send: async (input: { to: string[]; fromName?: string }) => {
      sent.push({ to: input.to, fromName: input.fromName });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-disabled',
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
      id: 'plan-disabled',
      createdAt: Date.now(),
      configId: 'cfg-disabled',
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: 'task-disabled',
      configId: 'cfg-disabled',
      disabled: true,
      daysOfWeek: [1],
      emails: ['disabled@example.com'],
      recentTimes: 0,
      senderNameTemplate: 'Labby {{ configId }}',
      templateText: 'Hi {{ recipient }}',
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

    await notifier.runTask('task-disabled');
    assert.equal(sent.length, 0);
    const afterScheduled = await store.getEmailTask('task-disabled');
    assert.equal(typeof afterScheduled?.lastSkippedAt, 'number');

    await notifier.runTaskNow('task-disabled');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.to, ['disabled@example.com']);
    assert.equal(sent[0]?.fromName, 'Labby cfg-disabled');
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier allows schedule helper functions and fails manual send on template errors', async () => {
  const dbPath = createTempDbPath('labby-email-task-template-errors');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string }) => {
      sent.push({ to: input.to, text: input.text });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: 'cfg-template-errors',
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
      id: 'plan-template-errors',
      createdAt: Date.now(),
      configId: 'cfg-template-errors',
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: 'task-template-helper',
      configId: 'cfg-template-errors',
      daysOfWeek: [1],
      emails: ['helper@example.com'],
      recentTimes: 0,
      templateText: 'Next {{ nextSessionDateText() }}',
      metadata: {},
    });

    const notifier = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
    });

    await notifier.runTaskNow('task-template-helper');
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /2026/);

    await store.putEmailTask({
      id: 'task-template-error',
      configId: 'cfg-template-errors',
      daysOfWeek: [1],
      emails: ['error@example.com'],
      recentTimes: 0,
      templateText: 'Broken {{ missingValue }}',
      metadata: {},
    });

    await assert.rejects(
      () => notifier.runTaskNow('task-template-error'),
      /failed for 1 recipient/,
    );
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier resolves timezone fallback and exposes ICS URL only when available', async () => {
  const dbPath = createTempDbPath('labby-email-task-timezone-ics-url');
  const store = new LabbyStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string; attachments?: Array<{ filename: string; content: Buffer }> }) => {
      sent.push({ to: input.to, text: input.text, attachments: input.attachments });
    },
  } as unknown as Mailer;

  try {
    await store.putSystemSettings({
      id: 'system',
      timezone: 'Asia/Tokyo',
    });

    await store.putConfig({
      id: 'cfg-tz',
      daysOfWeek: [1],
      timeRange: ['09:00', '10:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2026-01-01',
      endDate: '2099-01-31',
      metadata: {},
    });

    await store.putPerson({
      id: 'presenter',
      name: 'Presenter',
      names: { en: 'Presenter' },
      metadata: {},
      keywordIds: [],
    });

    await store.putSchedule({
      id: 'plan-tz',
      createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      configId: 'cfg-tz',
      sessions: [{ date: '2026-01-05', presentations: [{ presenterId: 'presenter', questionerIds: [] }] }],
    });

    await store.putEmailTask({
      id: 'task-tz',
      configId: 'cfg-tz',
      daysOfWeek: [1],
      emails: ['tz@example.com'],
      recentTimes: 0,
      templateText: '{{ runTimezone }}|{{ scheduleIcsUrl === undefined ? "missing" : scheduleIcsUrl }}',
      metadata: {
        timezoneSource: 'system',
        serveScheduleIcs: true,
      },
    });

    const notifierWithoutPublicIcs = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
      enablePublicEmailTaskIcs: false,
      publicBaseUrl: 'https://example.test',
    });

    await notifierWithoutPublicIcs.runTaskNow('task-tz');
    assert.equal(sent[0]?.text, 'Asia/Tokyo|missing');
    const firstIcs = sent[0]?.attachments?.find((item) => item.filename.endsWith('.ics'));
    assert.match(firstIcs?.content.toString('utf-8') ?? '', /DTSTART;TZID=Asia\/Tokyo:/);

    const notifierWithPublicIcs = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
      enablePublicEmailTaskIcs: true,
      publicBaseUrl: 'https://example.test/',
    });

    await notifierWithPublicIcs.runTaskNow('task-tz');
    assert.equal(sent[1]?.text, 'Asia/Tokyo|https://example.test/public/email-tasks/task-tz/schedule.ics');
  } finally {
    await store.close();
  }
});
