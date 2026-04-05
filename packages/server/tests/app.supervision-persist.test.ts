import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Keyword, KeywordVector } from '@labby/core';
import { createApp } from '../src/app.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

function makeHeaders(token?: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': 'test-request-id',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function login(app: Awaited<ReturnType<typeof createApp>>['app']): Promise<string> {
  const response = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: makeHeaders(),
    body: JSON.stringify({ identity: 'root', password: 'root-pass' }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { access_token: string };
  return payload.access_token;
}

function axisVector(axis: number, value: number): number[] {
  return Array.from({ length: 64 }, (_, i) => (i === axis ? value : 0));
}

test('nlp update-similarity persists vectors immediately', async () => {
  const runtime = await createApp({
    db: { dialect: 'sqlite', path: createTempDbPath('labby-app-supervision-persist') },
    rootUsername: 'root',
    rootPassword: 'root-pass',
  });

  try {
    const token = await login(runtime.app);

    const keywords: Keyword[] = [
      { id: 'k1', name: 'K1', names: { en: 'K1' }, metadata: {} },
      { id: 'k2', name: 'K2', names: { en: 'K2' }, metadata: {} },
      { id: 'k3', name: 'K3', names: { en: 'K3' }, metadata: {} },
    ];

    const vectors: KeywordVector[] = [
      {
        keywordId: 'k1',
        vector64: axisVector(0, 0.0),
        x: 0,
        y: 0,
        updatedAt: Date.now(),
      },
      {
        keywordId: 'k2',
        vector64: axisVector(0, 3.0),
        x: 3,
        y: 0,
        updatedAt: Date.now(),
      },
      {
        keywordId: 'k3',
        vector64: axisVector(0, 0.4),
        x: 0.4,
        y: 0,
        updatedAt: Date.now(),
      },
    ];

    for (const keyword of keywords) {
      const response = await runtime.app.request(`/api/v1/db/keywords/${keyword.id}`, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(keyword),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    for (const vector of vectors) {
      const response = await runtime.app.request(`/api/v1/db/keyword-vectors/${vector.keywordId}`, {
        method: 'PUT',
        headers: makeHeaders(token),
        body: JSON.stringify(vector),
      });
      assert.ok(response.status === 200 || response.status === 201);
    }

    const updateRes = await runtime.app.request('/api/v1/nlp/update-similarity', {
      method: 'POST',
      headers: makeHeaders(token),
      body: JSON.stringify({
        anchorId: 'k1',
        positiveId: 'k2',
        negativeId: 'k3',
        margin: 0.2,
        updateOptions: {
          learningRate: 0.06,
          minIters: 1,
          maxIters: 1,
        },
      }),
    });

    assert.equal(updateRes.status, 200);
    const updatePayload = await updateRes.json() as {
      data: { loss: number; updatedVectors: KeywordVector[] };
    };
    assert.ok(updatePayload.data.updatedVectors.length > 0);

    const persistedRes = await runtime.app.request('/api/v1/db/keyword-vectors/k1', {
      method: 'GET',
      headers: makeHeaders(token),
    });
    assert.equal(persistedRes.status, 200);
    const persistedPayload = await persistedRes.json() as { data: KeywordVector | null };
    assert.ok(persistedPayload.data, 'persisted vector should exist');

    const before = vectors[0].vector64[0] ?? 0;
    const after = persistedPayload.data?.vector64?.[0] ?? 0;
    assert.notEqual(after, before, 'vector should be persisted immediately after supervision');
  } finally {
    await runtime.close();
  }
});
