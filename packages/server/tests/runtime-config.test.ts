import assert from 'node:assert/strict';
import test from 'node:test';

import { createCloudSchedulerMirrorFromEnv } from '../src/cron/cloud-scheduler.js';
import { resolvePublicBaseUrl, resolveStoreConnectionConfig } from '../src/lib/runtime-config.js';

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('runtime db config allows sqlite defaults but fails when postgres config is partial or ignored', () => {
  assert.deepEqual(resolveStoreConnectionConfig({}), {
    dialect: 'sqlite',
    path: './run/labby.db',
  });

  assert.throws(
    () => resolveStoreConnectionConfig({ DATABASE_URL: 'postgres://db' }),
    /DB_DRIVER=postgres/,
  );
  assert.throws(
    () => resolveStoreConnectionConfig({ DB_DRIVER: 'postgres' }),
    /DATABASE_URL is required/,
  );
  assert.deepEqual(resolveStoreConnectionConfig({
    DB_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db',
    DATABASE_SSL: 'true',
  }), {
    dialect: 'postgres',
    connectionString: 'postgres://db',
    ssl: true,
  });
});

test('runtime public base url allows localhost fallback but validates explicit values', () => {
  assert.equal(resolvePublicBaseUrl({}, 4410), 'http://localhost:4410');
  assert.equal(
    resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://labby.example.com' }, 4410),
    'https://labby.example.com',
  );
  assert.throws(
    () => resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'labby.example.com' }, 4410),
    /absolute http\(s\) URL/,
  );
});

test('cloud scheduler mirror env validates dispatch url when reliable scheduler config is present', () => {
  withEnv({
    CLOUD_SCHEDULER_PROJECT_ID: 'project',
    CLOUD_SCHEDULER_LOCATION: 'us-central1',
    SCHEDULER_DISPATCH_API_KEY: 'secret',
    CLOUD_SCHEDULER_DISPATCH_URL: undefined,
    PUBLIC_BASE_URL: 'ftp://example.com',
  }, () => {
    assert.throws(() => createCloudSchedulerMirrorFromEnv(), /PUBLIC_BASE_URL must use http or https/);
  });

  withEnv({
    CLOUD_SCHEDULER_PROJECT_ID: 'project',
    CLOUD_SCHEDULER_LOCATION: 'us-central1',
    SCHEDULER_DISPATCH_API_KEY: 'secret',
    CLOUD_SCHEDULER_DISPATCH_URL: 'https://example.com/internal/scheduler/dispatch',
    PUBLIC_BASE_URL: undefined,
  }, () => {
    assert.notEqual(createCloudSchedulerMirrorFromEnv(), null);
  });
});
