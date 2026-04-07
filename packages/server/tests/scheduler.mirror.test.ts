import assert from 'node:assert/strict';
import test from 'node:test';

import { CronScheduler } from '../src/cron/scheduler.js';

class FakeMirror {
  readonly upserts: string[] = [];
  readonly removals: string[] = [];
  syncedNames: string[] = [];

  async upsert(definition: { name: string }): Promise<void> {
    this.upserts.push(definition.name);
  }

  async remove(name: string): Promise<void> {
    this.removals.push(name);
  }

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

  await scheduler.syncMirrorNow();
  assert.deepEqual(mirror.syncedNames, ['job-a']);

  scheduler.unregister('job-a');
  assert.deepEqual(scheduler.registeredJobs, []);
  assert.ok(mirror.upserts.includes('job-a'));
  assert.ok(mirror.removals.includes('job-a'));
});
