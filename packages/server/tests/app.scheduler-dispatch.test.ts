import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

test('internal scheduler dispatch endpoint validates auth and dispatches by job name', async () => {
  const runtime = await createApp({
    db: { dialect: 'sqlite', path: createTempDbPath('labby-scheduler-dispatch') },
    rootUsername: 'root',
    rootPassword: 'root-pass',
    schedulerDispatchApiKey: 'dispatch-key',
    onSchedulerDispatch: async (jobName: string) => jobName === 'auth-maintenance-cleanup',
  });

  try {
    const unauth = await runtime.app.request('/internal/scheduler/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobName: 'auth-maintenance-cleanup' }),
    });
    assert.equal(unauth.status, 401);

    const missingJob = await runtime.app.request('/internal/scheduler/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': 'dispatch-key',
      },
      body: JSON.stringify({}),
    });
    assert.equal(missingJob.status, 400);

    const notFound = await runtime.app.request('/internal/scheduler/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': 'dispatch-key',
      },
      body: JSON.stringify({ jobName: 'unknown-job' }),
    });
    assert.equal(notFound.status, 404);

    const ok = await runtime.app.request('/internal/scheduler/dispatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': 'dispatch-key',
      },
      body: JSON.stringify({ jobName: 'auth-maintenance-cleanup' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await runtime.close();
  }
});
