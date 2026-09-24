import { createTestStore, testUuid } from './support/database.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Mailer } from '../src/lib/mailer.js';
import { EmailTaskNotifier } from '../src/cron/email-task-notifier.js';
import { LabbyStore } from '../src/store/index.js';
import { SYSTEM_SETTINGS_ID } from '@labby/core';

const id = testUuid;

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

class FakeScheduler {
  private readonly defs = new Map<string, { handler: () => Promise<void> | void; expression?: string; timezone?: string }>();

  register(def: { name: string; handler: () => Promise<void> | void; expression?: string; timezone?: string }): { name: string; stop: () => void } {
    this.defs.set(def.name, { handler: def.handler, expression: def.expression, timezone: def.timezone });
    return { name: def.name, stop: () => this.unregister(def.name) };
  }

  unregister(name: string): void {
    this.defs.delete(name);
  }

  get registeredJobs(): string[] {
    return [...this.defs.keys()];
  }

  getJob(name: string) { return this.defs.get(name); }
}

test('EmailTaskNotifier syncs jobs and sends per-recipient with independent counters', async () => {
  const dbPath = createTempDbPath('labby-email-task');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string; attachments?: Array<{ filename: string }> }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string; attachments?: Array<{ filename: string }> }) => {
      sent.push({ to: input.to, text: input.text, attachments: input.attachments });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-1'),
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
      id: id('plan-1'),
      createdAt: Date.now(),
      configId: id('cfg-1'),
      sessions: [{ date: '2099-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: id('task-1'),
      configId: id('cfg-1'),
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
    assert.ok(scheduler.registeredJobs.includes(`email-task:${id('task-1')}`));

    await notifier.runTask(id('task-1'));

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.to, ['b@example.com']);
    assert.ok((sent[0]?.text ?? '').includes('b@example.com'));
    assert.equal(sent[0]?.attachments?.length, 2);
    assert.ok(sent[0]?.attachments?.some((item) => item.filename.endsWith('.csv')));
    assert.ok(sent[0]?.attachments?.some((item) => item.filename.endsWith('.ics')));

    const updated = await store.getEmailTask(id('task-1'));
    assert.equal(updated?.sentCounts?.['a@example.com'], 1);
    assert.equal(updated?.sentCounts?.['b@example.com'], 1);
    assert.equal(typeof updated?.lastRunAt, 'number');
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier sends scheduled delivery on every matching run', async () => {
  const dbPath = createTempDbPath('labby-email-task-stale');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[] }> = [];

  const mailer = {
    send: async (input: { to: string[] }) => {
      sent.push({ to: input.to });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-stale'),
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
      id: id('plan-stale'),
      createdAt: Date.now(),
      configId: id('cfg-stale'),
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: id('task-stale'),
      configId: id('cfg-stale'),
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

    await notifier.runTask(id('task-stale'));
    await notifier.runTask(id('task-stale'));

    assert.equal(sent.length, 2);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier consumes skip-next once after manual send, even without newer schedule', async () => {
  const dbPath = createTempDbPath('labby-email-task-skip-next-once');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[] }> = [];

  const mailer = {
    send: async (input: { to: string[] }) => {
      sent.push({ to: input.to });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-skip-next'),
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
      id: id('plan-skip-next'),
      createdAt: Date.now(),
      configId: id('cfg-skip-next'),
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: id('task-skip-next'),
      configId: id('cfg-skip-next'),
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
    await notifier.runTaskNow(id('task-skip-next'), ['skip-next@example.com']);
    assert.equal(sent.length, 1);

    // First scheduled run consumes skip-next and should not send.
    await notifier.runTask(id('task-skip-next'));
    assert.equal(sent.length, 1);
    const afterFirstScheduled = await store.getEmailTask(id('task-skip-next'));
    assert.equal(afterFirstScheduled?.skipNextRun, false);
    assert.equal(typeof afterFirstScheduled?.lastSkippedAt, 'number');

    // Later scheduled runs can send again once skip-next has been consumed.
    await notifier.runTask(id('task-skip-next'));
    assert.equal(sent.length, 2);
    const afterSecondScheduled = await store.getEmailTask(id('task-skip-next'));
    assert.equal(afterSecondScheduled?.skipNextRun, false);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier respects a postponed final meeting after the configured period', async () => {
  const dbPath = createTempDbPath('labby-email-task-ended');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();

  let deliveries = 0;
  const mailer = { send: async () => { deliveries++; } } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-ended'),
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
      id: id('task-ended'),
      configId: id('cfg-ended'),
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
    await store.putPerson({ id: id('ended-presenter'), name: 'Presenter', names: { en: 'Presenter' }, metadata: {}, keywordIds: [] });
    await store.putPerson({ id: id('ended-questioner'), name: 'Questioner', names: { en: 'Questioner' }, metadata: {}, keywordIds: [] });
    await store.putSchedule({ id: id('extended-plan'), configId: id('cfg-ended'), createdAt: Date.now(),
      sessions: [{ date: '2099-01-05', presentations: [{ presenterId: id('ended-presenter'), questionerIds: [id('ended-questioner')] }] }] });
    await notifier.syncJobs();
    assert.deepEqual(scheduler.registeredJobs, [`email-task:${id('task-ended')}`]);
    await notifier.runTask(id('task-ended'));
    assert.equal(deliveries, 1);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier skips disabled scheduled runs but allows manual send with sender name template', async () => {
  const dbPath = createTempDbPath('labby-email-task-disabled-manual');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; fromName?: string }> = [];

  const mailer = {
    send: async (input: { to: string[]; fromName?: string }) => {
      sent.push({ to: input.to, fromName: input.fromName });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-disabled'),
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
      id: id('plan-disabled'),
      createdAt: Date.now(),
      configId: id('cfg-disabled'),
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: id('task-disabled'),
      configId: id('cfg-disabled'),
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

    await notifier.runTask(id('task-disabled'));
    assert.equal(sent.length, 0);
    const afterScheduled = await store.getEmailTask(id('task-disabled'));
    assert.equal(typeof afterScheduled?.lastSkippedAt, 'number');

    const manualResult = await notifier.runTaskNow(id('task-disabled'), ['one-off@example.com']);
    assert.deepEqual(manualResult, { sent: 1, failed: 0 });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.to, ['one-off@example.com']);
    assert.equal(sent[0]?.fromName, `Labby ${id('cfg-disabled')}`);
    assert.deepEqual((await store.getEmailTask(id('task-disabled')))?.emails, ['disabled@example.com']);
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier allows schedule helper functions and fails manual send on template errors', async () => {
  const dbPath = createTempDbPath('labby-email-task-template-errors');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string }) => {
      sent.push({ to: input.to, text: input.text });
    },
  } as unknown as Mailer;

  try {
    await store.putConfig({
      id: id('cfg-template-errors'),
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
      id: id('plan-template-errors'),
      createdAt: Date.now(),
      configId: id('cfg-template-errors'),
      sessions: [{ date: '2026-01-05', presentations: [] }],
    });

    await store.putEmailTask({
      id: id('task-template-helper'),
      configId: id('cfg-template-errors'),
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

    await notifier.runTaskNow(id('task-template-helper'), ['helper@example.com']);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? '', /2026/);

    await store.putEmailTask({
      id: id('task-template-error'),
      configId: id('cfg-template-errors'),
      daysOfWeek: [1],
      emails: ['error@example.com'],
      recentTimes: 0,
      templateText: 'Broken {{ missingValue }}',
      metadata: {},
    });

    await assert.rejects(
      () => notifier.runTaskNow(id('task-template-error'), ['error@example.com']),
      /failed for 1 recipient/,
    );
  } finally {
    await store.close();
  }
});

test('EmailTaskNotifier resolves timezone fallback and exposes ICS URL only when available', async () => {
  const dbPath = createTempDbPath('labby-email-task-timezone-ics-url');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });
  const scheduler = new FakeScheduler();
  const sent: Array<{ to: string[]; text?: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];

  const mailer = {
    send: async (input: { to: string[]; text?: string; attachments?: Array<{ filename: string; content: Buffer }> }) => {
      sent.push({ to: input.to, text: input.text, attachments: input.attachments });
    },
  } as unknown as Mailer;

  try {
    await store.putSystemSettings({
      id: SYSTEM_SETTINGS_ID,
      timezone: 'Asia/Tokyo',
    });

    await store.putConfig({
      id: id('cfg-tz'),
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
      id: id('presenter'),
      name: 'Presenter',
      names: { en: 'Presenter' },
      metadata: {},
      keywordIds: [],
    });

    await store.putSchedule({
      id: id('plan-tz'),
      createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      configId: id('cfg-tz'),
      sessions: [{ date: '2026-01-05', presentations: [{ presenterId: id('presenter'), questionerIds: [] }] }],
    });

    await store.putEmailTask({
      id: id('task-tz'),
      configId: id('cfg-tz'),
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
    });

    await notifierWithoutPublicIcs.runTaskNow(id('task-tz'), ['tz@example.com']);
    assert.equal(sent[0]?.text, 'Asia/Tokyo|missing');
    const firstIcs = sent[0]?.attachments?.find((item) => item.filename.endsWith('.ics'));
    assert.match(firstIcs?.content.toString('utf-8') ?? '', /DTSTART:20260105T000000Z/);

    const notifierWithPublicIcs = new EmailTaskNotifier({
      scheduler: scheduler as unknown as any,
      mailer,
      store,
      defaultHour: 9,
      publicBaseUrl: 'https://example.test/',
    });

    await notifierWithPublicIcs.runTaskNow(id('task-tz'), ['tz@example.com']);
    assert.equal(sent[1]?.text, `Asia/Tokyo|https://example.test/public/email-tasks/${id('task-tz')}/schedule.ics`);
  } finally {
    await store.close();
  }
});

test('email send timezone does not change schedule times in templates or ICS', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: createTempDbPath('labby-mail-meeting-timezones') });
  const scheduler = new FakeScheduler();
  const sent: Array<{ text?: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
  const mailer = { send: async (input: { text?: string; attachments?: Array<{ filename: string; content: Buffer }> }) => { sent.push(input); } } as unknown as Mailer;
  try {
    const configId = id('cfg-two-timezones');
    const taskId = id('task-two-timezones');
    await store.putSystemSettings({ id: SYSTEM_SETTINGS_ID, timezone: 'UTC' });
    await store.putConfig({ id: configId, daysOfWeek: [1], timeRange: ['09:00', '11:00'], timezone: 'Asia/Tokyo',
      presentersPerSession: 1, questionersPerPresenter: 0, targetSimilarityRadius: 0.5,
      startDate: '2026-01-01', endDate: '2099-01-31', metadata: {} });
    await store.putPerson({ id: id('timezone-presenter'), name: 'Presenter', names: { en: 'Presenter' }, metadata: {}, keywordIds: [] });
    await store.putSchedule({ id: id('timezone-plan'), configId, createdAt: Date.UTC(2026, 0, 1),
      sessions: [{ date: '2026-01-05', presentations: [{ presenterId: id('timezone-presenter'), questionerIds: [] }] }] });
    await store.putEmailTask({ id: taskId, configId, daysOfWeek: [1], sendTime: '12:00', timezone: 'Asia/Shanghai',
      emails: ['test@example.com'], recentTimes: 0,
      templateText: '{{ runTimezone }}|{{ nextSessionTimeText() }}',
      metadata: { timezoneSource: 'task', attachmentTypes: ['schedule-semester-ics'] } });
    const notifier = new EmailTaskNotifier({ scheduler: scheduler as unknown as any, mailer, store });
    await notifier.syncJobs();
    assert.equal(scheduler.getJob(`email-task:${taskId}`)?.expression, '0 12 * * 1');
    assert.equal(scheduler.getJob(`email-task:${taskId}`)?.timezone, 'Asia/Shanghai');
    await notifier.runTaskNow(taskId, ['test@example.com']);
    assert.match(sent[0]?.text ?? '', /^Asia\/Shanghai\|.*09:00.*11:00/);
    const ics = sent[0]?.attachments?.find(item => item.filename.endsWith('.ics'))?.content.toString('utf8') ?? '';
    assert.match(ics, /DTSTART:20260105T000000Z/);
    assert.match(ics, /DTEND:20260105T020000Z/);
  } finally { await store.close(); }
});
