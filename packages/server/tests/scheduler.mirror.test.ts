import assert from 'node:assert/strict';
import test from 'node:test';

import { CronScheduler, resolveDynamicSchedulerMode, resolveStaticSchedulerMode } from '../src/cron/scheduler.js';

class FakeMirror {
  syncedNames: string[] = [];

  async sync(definitions: Array<{ name: string }>): Promise<void> {
    this.syncedNames = definitions.map((item) => item.name).sort();
  }
}

test('CronScheduler cloud mode keeps definitions and can dispatch manually', async () => {
  const scheduler = new CronScheduler();
  const mirror = new FakeMirror();
  scheduler.setMode('cloud');
  scheduler.setMirror(mirror);

  let runs = 0;
  scheduler.register({
    name: 'job-a',
    expression: '*/5 * * * *',
    handler: async () => {
      runs += 1;
    },
  });

  assert.deepEqual(scheduler.registeredJobs, ['job-a']);

  const ok = await scheduler.runNow('job-a');
  assert.equal(ok, true);
  assert.equal(runs, 1);

  await scheduler.sync();
  assert.deepEqual(mirror.syncedNames, ['job-a']);

  scheduler.unregister('job-a');
  assert.deepEqual(scheduler.registeredJobs, []);
  await scheduler.sync();
  assert.deepEqual(mirror.syncedNames, []);
});

test('static and dynamic mode values are validated separately', () => {
  assert.equal(resolveStaticSchedulerMode('external'), 'external');
  assert.equal(resolveDynamicSchedulerMode('cloud'), 'cloud');
  assert.equal(resolveStaticSchedulerMode(undefined), 'cron');
  assert.equal(resolveDynamicSchedulerMode(undefined), 'cron');
  assert.throws(() => resolveDynamicSchedulerMode('external'), /cannot be external/);
  assert.throws(() => resolveStaticSchedulerMode('mixed'), /Unsupported STATIC_SCHEDULER_MODE/);
  assert.throws(() => resolveDynamicSchedulerMode('typo'), /Unsupported DYNAMIC_SCHEDULER_MODE/);

  const scheduler = new CronScheduler();
  scheduler.setMode('external');
  scheduler.register({ name: 'job-a', expression: '*/5 * * * *', handler: () => {} });
  assert.deepEqual(scheduler.registeredJobs, ['job-a']);
  scheduler.shutdown();
});

test('scheduler serializes remote reconciliation and uses the newest definitions', async () => {
  const scheduler = new CronScheduler();
  scheduler.setMode('cloud');
  const snapshots: string[][] = [];
  scheduler.setMirror({
    async sync(definitions) {
      snapshots.push(definitions.map((definition) => definition.name));
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  });
  scheduler.register({ name: 'old', expression: '0 0 * * *', handler: () => {} });
  const first = scheduler.sync();
  scheduler.unregister('old');
  scheduler.register({ name: 'new', expression: '0 0 * * *', handler: () => {} });
  const second = scheduler.sync();
  await Promise.all([first, second]);
  assert.deepEqual(snapshots, [['new'], ['new']]);
});

test('a second dispatch does not overlap a running handler', async () => {
  const scheduler = new CronScheduler();
  scheduler.setMode('external');
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  scheduler.register({ name: 'fixed', expression: '0 0 * * *', handler: async () => { calls++; await pending; } });
  const first = scheduler.runNow('fixed');
  await Promise.resolve();
  assert.equal(await scheduler.runNow('fixed'), true);
  finish();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});
