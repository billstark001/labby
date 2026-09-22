import { createTestApp, testUuid } from './support/database.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { productDistance, type RankingJudgment, type RankingQuery, type TrainingResult } from '@labby/core';
import { createApp } from '../src/app.js';

function makeHeaders(token?: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-Request-Id': 'test-request-id', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function login(app: Awaited<ReturnType<typeof createApp>>['app'], identity = 'root', password = 'root-pass'): Promise<string> {
  const response = await app.request('/api/v1/auth/login', { method: 'POST', headers: makeHeaders(), body: JSON.stringify({ identity, password }) });
  assert.equal(response.status, 200);
  return (await response.json() as { access_token: string }).access_token;
}

test('joint list training persists vectors and history immediately, survives restart, and rejects conflicts atomically', async () => {
  const keywordId = (label: string) => testUuid(`ranking-keyword:${label}`);
  const ids = Object.fromEntries(['0', '1', '2', '3', '4', '5', 'uninitialized', 'missing'].map(label => [label, keywordId(label)]));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labby-ranking-api-'));
  const config = { db: { dialect: 'pglite' as const, dataDir: path.join(tempDir, 'db') }, rootUsername: 'root', rootPassword: 'root-pass' };
  let runtime = await createTestApp(config);
  try {
    let token = await login(runtime.app);
    let seed = 1;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const label of ['0', '1', '2', '3', '4', '5']) {
      const id = ids[label]!;
      await runtime.store.putKeyword({ id, name: label, names: {}, metadata: {} });
      await runtime.store.putKeywordVector({ keywordId: id, geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 }, embedding: Array.from({ length: 8 }, () => (random() - 0.5) / 2), x: 0, y: 0, updatedAt: 1 });
    }
    const graphResponse = await runtime.app.request('/api/v1/db/graph?limit=2', { headers: makeHeaders(token) });
    assert.equal(graphResponse.status, 200);
    const graphPage = (await graphResponse.json() as { data: {items:unknown[];nextCursor:string} }).data;
    assert.equal(graphPage.items.length, 2);
    assert.ok(graphPage.nextCursor);
    const invalidGraph = await runtime.app.request('/api/v1/db/graph?cursor=broken', { headers: makeHeaders(token) });
    assert.equal(invalidGraph.status, 400);
    const anonymousGraph = await runtime.app.request('/api/v1/db/graph', { headers: makeHeaders() });
    assert.equal(anonymousGraph.status, 401);
    const removedGraph = await runtime.app.request('/api/v1/db/graph-snapshot', { headers: makeHeaders(token) });
    assert.equal(removedGraph.status, 404);
    const initial = await runtime.store.listKeywordVectors();
    const j: RankingJudgment = { id: testUuid('list-1'), anchorId: ids['0']!, groups: [[ids['1']!, ids['2']!], [ids['3']!], [ids['4']!, ids['5']!]], confidence: 1, createdAt: 1 };
    const train = (body: unknown, auth = token) => runtime.app.request('/api/v1/nlp/train-ranking', { method: 'POST', headers: makeHeaders(auth), body: JSON.stringify(body) });
    const response = await train(j);
    assert.equal(response.status, 200);
    const result = (await response.json() as { data: TrainingResult }).data;
    assert.equal(result.accepted, true, result.conflicts.join('; '));
    assert.ok(result.updatedVectors.length > 0);
    const persisted = await runtime.store.listKeywordVectors();
    assert.notDeepEqual(persisted, initial);
    assert.deepEqual(await runtime.store.getRankingHistory(), [j]);
    const byId = new Map(persisted.map(v => [v.keywordId, v]));
    for (const updated of result.updatedVectors) assert.deepEqual(byId.get(updated.keywordId), updated);
    const distance = (label: string) => productDistance(byId.get(ids['0']!)!, byId.get(ids[label]!)!) ** 2;
    assert.ok(Math.abs(distance('1') - distance('2')) <= 0.04000001);
    for (const near of ['1', '2']) assert.ok(distance(near) < distance('3'));
    for (const far of ['4', '5']) assert.ok(distance('3') < distance(far));

    const duplicate = await train(j);
    assert.equal(duplicate.status, 200);
    assert.deepEqual((await duplicate.json() as { data: TrainingResult }).data.updatedVectors, []);
    const reorderedTie = await train({ ...j, groups: [[ids['2']!, ids['1']!], [ids['3']!], [ids['5']!, ids['4']!]] });
    assert.equal(reorderedTie.status, 200);
    assert.deepEqual((await reorderedTie.json() as { data: TrainingResult }).data.updatedVectors, []);
    // A rejected judgment must not persist even lazy initialization of another keyword.
    await runtime.store.putKeyword({ id: ids.uninitialized!, name: 'Uninitialized', names: {}, metadata: {} });
    const rejected = await train({ ...j, id: testUuid('conflict'), groups: [[ids['3']!], [ids['1']!]] });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json() as { data: TrainingResult }).data.accepted, false);
    assert.deepEqual(await runtime.store.listKeywordVectors(), persisted);
    assert.deepEqual(await runtime.store.getRankingHistory(), [j]);
    await runtime.store.deleteKeyword(ids.uninitialized!);

    const recommend = (body: unknown) => runtime.app.request('/api/v1/nlp/recommend-ranking', { method: 'POST', headers: makeHeaders(token), body: JSON.stringify(body) });
    const recommendation = await recommend({ size: 4, excludedKeys: [] });
    assert.equal(recommendation.status, 200);
    const query = (await recommendation.json() as { data: { query: RankingQuery } }).data.query;
    assert.equal(query.candidateIds.length, 4);
    assert.equal(new Set(query.candidateIds).size, 4);
    assert.ok(!query.candidateIds.includes(query.anchorId));
    const nextRecommendation = await recommend({ size: 4, excludedKeys: [query.key] });
    assert.equal(nextRecommendation.status, 200);
    assert.notEqual((await nextRecommendation.json() as { data: { query: RankingQuery } }).data.query.key, query.key);

    assert.equal((await train(j, '')).status, 401);
    const createUser = await runtime.app.request('/api/v1/users', { method: 'POST', headers: makeHeaders(token), body: JSON.stringify({ username: 'reader', password: 'reader-password', role: 0 }) });
    assert.equal(createUser.status, 201);
    const readerToken = await login(runtime.app, 'reader', 'reader-password');
    assert.equal((await train(j, readerToken)).status, 403);
    assert.equal((await runtime.app.request('/api/v1/nlp/recommend-ranking', { method: 'POST', headers: makeHeaders(readerToken), body: '{}' })).status, 403);
    assert.equal((await runtime.app.request('/api/v1/nlp/history', { headers: makeHeaders(readerToken) })).status, 403);
    for (const groups of [[[ids['1']!], [ids['1']!]], [[ids['0']!], [ids['1']!]], [[ids['1']!], [ids.missing!]], [[]]]) assert.equal((await train({ ...j, id: testUuid('invalid'), groups })).status, 400);
    assert.equal((await train({ ...j, confidence: 0 })).status, 400);
    assert.equal((await recommend({ size: 1 })).status, 400);
    assert.equal((await runtime.app.request('/api/v1/nlp/update-similarity', { method: 'POST', headers: makeHeaders(token), body: '{}' })).status, 404);
    assert.deepEqual(await runtime.store.listKeywordVectors(), persisted);
    assert.deepEqual(await runtime.store.getRankingHistory(), [j]);

    await runtime.close();
    runtime = await createTestApp(config);
    token = await login(runtime.app);
    assert.deepEqual(await runtime.store.listKeywordVectors(), persisted);
    const historyResponse = await runtime.app.request('/api/v1/nlp/history', { headers: makeHeaders(token) });
    assert.equal(historyResponse.status, 200);
    assert.deepEqual((await historyResponse.json() as { data: RankingJudgment[] }).data, [j]);
    const restartedConflict = await train({ ...j, id: testUuid('after-restart'), groups: [[ids['3']!], [ids['1']!]] });
    assert.equal((await restartedConflict.json() as { data: TrainingResult }).data.accepted, false);
    assert.deepEqual(await runtime.store.listKeywordVectors(), persisted);
  } finally {
    await runtime.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
