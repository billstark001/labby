import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchRailwayCron } from '../src/cron/railway-dispatch.js';

const baseEnv = {
  LABBY_SERVER_URL: 'https://labby.example/',
  SCHEDULER_DISPATCH_API_KEY: 'test-key',
  LABBY_CRON_JOB: 'database-backup',
};

test('Railway cron dispatch retries a serverless cold-start gateway response', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const waits: number[] = [];
  const responses = [
    new Response('cold start', { status: 502 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];

  await dispatchRailwayCron({
    env: baseEnv,
    fetch: (async (input, init) => {
      requests.push({ url: String(input), init });
      return responses.shift()!;
    }) as typeof fetch,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, 'https://labby.example/internal/scheduler/dispatch');
  assert.equal(new Headers(requests[0]?.init?.headers).get('x-api-key'), 'test-key');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { jobName: 'database-backup' });
  assert.deepEqual(waits, [1_000]);
});

test('Railway cron dispatch does not retry application failures', async () => {
  let requests = 0;
  await assert.rejects(
    dispatchRailwayCron({
      env: baseEnv,
      fetch: (async () => {
        requests += 1;
        return new Response('unknown job', { status: 404 });
      }) as typeof fetch,
      sleep: async () => assert.fail('should not wait for a non-retryable response'),
    }),
    /failed after 1 attempt\(s\): HTTP 404: unknown job/,
  );
  assert.equal(requests, 1);
});

test('Railway cron dispatch validates security and numeric configuration', async () => {
  await assert.rejects(
    dispatchRailwayCron({ env: { ...baseEnv, LABBY_SERVER_URL: 'http://labby.example' } }),
    /must use HTTPS/,
  );
  await assert.rejects(
    dispatchRailwayCron({ env: { ...baseEnv, LABBY_CRON_TIMEOUT_MS: 'not-a-number' } }),
    /LABBY_CRON_TIMEOUT_MS must be a positive integer/,
  );
});
