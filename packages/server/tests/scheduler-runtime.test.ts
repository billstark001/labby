import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchedulerRuntimeFromEnv } from '../src/cron/scheduler-runtime.js';
import { CronScheduler } from '../src/cron/scheduler.js';

test('local runtime schedules every registered job through the same contract', async () => {
  const runtime = createSchedulerRuntimeFromEnv({ STATIC_SCHEDULER_MODE: 'cron', DYNAMIC_SCHEDULER_MODE: 'cron' });
  const scheduler = runtime.dynamicJobs;
  const invoked: string[] = [];
  try {
    for (const name of ['auth-maintenance-cleanup', 'email-task:task-1', 'database-backup', 'schedule-notify:config-1']) {
      scheduler.register({
        name,
        expression: '0 0 1 1 *',
        handler: () => { invoked.push(name); },
      });
    }
    assert.equal(runtime.staticMode, 'cron');
    assert.equal(runtime.dynamicMode, 'cron');
    assert.equal(runtime.staticJobs, runtime.dynamicJobs);
    assert.equal(scheduler.registeredJobs.length, 4);
    for (const name of scheduler.registeredJobs) assert.equal(await runtime.runNow(name), true);
    assert.deepEqual(invoked, scheduler.registeredJobs);
  } finally {
    runtime.shutdown();
  }
});

test('external fixed jobs and cloud dynamic jobs use separate schedulers', async () => {
  const runtime = createSchedulerRuntimeFromEnv({
    STATIC_SCHEDULER_MODE: 'external',
    DYNAMIC_SCHEDULER_MODE: 'cloud',
    SCHEDULER_DISPATCH_API_KEY: 'test-key',
    CLOUD_SCHEDULER_PROJECT_ID: 'test-project',
    CLOUD_SCHEDULER_LOCATION: 'asia-northeast1',
    PUBLIC_BASE_URL: 'https://example.com',
  });
  const invoked: string[] = [];
  runtime.staticJobs.register({ name: 'auth-maintenance-cleanup', expression: '0 0 * * *', handler: () => { invoked.push('static'); } });
  runtime.dynamicJobs.register({ name: 'email-task:one', expression: '0 0 * * *', handler: () => { invoked.push('dynamic'); } });
  assert.equal(runtime.staticMode, 'external');
  assert.equal(runtime.dynamicMode, 'cloud');
  assert.notEqual(runtime.staticJobs, runtime.dynamicJobs);
  assert.equal(await runtime.runNow('auth-maintenance-cleanup'), true);
  assert.equal(await runtime.runNow('email-task:one'), true);
  assert.equal(await runtime.runNow('missing'), false);
  assert.deepEqual(invoked, ['static', 'dynamic']);
  runtime.shutdown();
});

test('cloud and external modes require the relevant dispatch configuration', () => {
  assert.throws(() => createSchedulerRuntimeFromEnv({ NODE_ENV: 'production' }), /Production requires STATIC_SCHEDULER_MODE and DYNAMIC_SCHEDULER_MODE/);
  assert.throws(() => createSchedulerRuntimeFromEnv({ STATIC_SCHEDULER_MODE: 'external' }), /SCHEDULER_DISPATCH_API_KEY/);
  assert.throws(() => createSchedulerRuntimeFromEnv({ DYNAMIC_SCHEDULER_MODE: 'cloud', SCHEDULER_DISPATCH_API_KEY: 'key' }), /CLOUD_SCHEDULER_PROJECT_ID/);
  const runtime = createSchedulerRuntimeFromEnv({
    STATIC_SCHEDULER_MODE: 'external',
    DYNAMIC_SCHEDULER_MODE: 'cron',
    SCHEDULER_DISPATCH_API_KEY: 'key',
  });
  assert.equal(runtime.staticMode, 'external');
  assert.equal(runtime.dynamicMode, 'cron');
  runtime.shutdown();
});

test('both cloud job groups share one mirror so reconciliation includes both', async () => {
  const runtime = createSchedulerRuntimeFromEnv({
    STATIC_SCHEDULER_MODE: 'cloud',
    DYNAMIC_SCHEDULER_MODE: 'cloud',
    SCHEDULER_DISPATCH_API_KEY: 'key',
    CLOUD_SCHEDULER_PROJECT_ID: 'test-project',
    CLOUD_SCHEDULER_LOCATION: 'asia-northeast1',
    PUBLIC_BASE_URL: 'https://example.com',
  });
  assert.equal(runtime.staticJobs, runtime.dynamicJobs);
  assert.equal(runtime.staticMode, 'cloud');
  assert.equal(runtime.dynamicMode, 'cloud');
  let syncedNames: string[] = [];
  (runtime.dynamicJobs as CronScheduler).setMirror({
    async sync(definitions) { syncedNames = definitions.map((definition) => definition.name).sort(); },
  });
  runtime.staticJobs.register({ name: 'auth-maintenance-cleanup', expression: '0 0 * * *', handler: () => {} });
  runtime.dynamicJobs.register({ name: 'email-task:one', expression: '0 0 * * *', handler: () => {} });
  await runtime.sync();
  assert.deepEqual(syncedNames, ['auth-maintenance-cleanup', 'email-task:one']);
  runtime.shutdown();
});

test('cloud fixed jobs and local dynamic jobs use independent schedulers', async () => {
  const runtime = createSchedulerRuntimeFromEnv({
    STATIC_SCHEDULER_MODE: 'cloud',
    DYNAMIC_SCHEDULER_MODE: 'cron',
    SCHEDULER_DISPATCH_API_KEY: 'key',
    CLOUD_SCHEDULER_PROJECT_ID: 'test-project',
    CLOUD_SCHEDULER_LOCATION: 'asia-northeast1',
    PUBLIC_BASE_URL: 'https://example.com',
  });
  assert.notEqual(runtime.staticJobs, runtime.dynamicJobs);
  assert.equal(runtime.staticMode, 'cloud');
  assert.equal(runtime.dynamicMode, 'cron');
  let syncedNames: string[] = [];
  (runtime.staticJobs as CronScheduler).setMirror({
    async sync(definitions) { syncedNames = definitions.map((definition) => definition.name); },
  });
  runtime.staticJobs.register({ name: 'auth-maintenance-cleanup', expression: '0 0 * * *', handler: () => {} });
  await runtime.sync();
  assert.deepEqual(syncedNames, ['auth-maintenance-cleanup']);
  runtime.shutdown();
});
