import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchOccurrenceId } from '../src/cron/dispatch-occurrence.js';
import { createSchedulerRuntimeFromEnv, dispatchScheduledJob } from '../src/cron/scheduler-runtime.js';
import { createTestStore } from './support/database.js';

test('provider retry identifiers remain stable for one occurrence and differ across occurrences', () => {
  const first = dispatchOccurrenceId({ cloudJobName: 'projects/p/locations/r/jobs/one', cloudScheduleTime: '2026-09-25T01:00:00Z' });
  assert.equal(first, dispatchOccurrenceId({ cloudJobName: 'projects/p/locations/r/jobs/one', cloudScheduleTime: '2026-09-25T01:00:00Z' }));
  assert.notEqual(first, dispatchOccurrenceId({ cloudJobName: 'projects/p/locations/r/jobs/one', cloudScheduleTime: '2026-09-26T01:00:00Z' }));
  assert.notEqual(first, dispatchOccurrenceId({ railwayDispatchId: '9e60980e-54b8-4786-80a3-2d32cfc47d6e' }));
  assert.equal(dispatchOccurrenceId({ railwayDispatchId: 'invalid' }), undefined);
});

test('the database ledger permits one dispatch across simultaneous retries', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  const runtime = createSchedulerRuntimeFromEnv({ STATIC_SCHEDULER_MODE: 'cron', DYNAMIC_SCHEDULER_MODE: 'cron' });
  let runs = 0;
  runtime.staticJobs.register({ name: 'auth-maintenance-cleanup', expression: '0 0 1 1 *', handler: async () => { runs += 1; } });
  try {
    const occurrenceId = 'a'.repeat(64);
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      dispatchScheduledJob(runtime, store, 'auth-maintenance-cleanup', occurrenceId)));
    assert.deepEqual(results, [true, true, true]);
    assert.equal(runs, 1);
    assert.equal(await dispatchScheduledJob(runtime, store, 'missing', 'b'.repeat(64)), false);
    assert.equal(await store.claimSchedulerDispatch(occurrenceId, 'auth-maintenance-cleanup'), false);
  } finally {
    runtime.shutdown();
    await store.close();
  }
});
