import { createTestStore, testUuid } from './support/database.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeywordVector, RankingJudgment } from '@labby/core';
import { LabbyStore } from '../src/store/index.js';

const geometry = { hyperbolicDimensions: 4, euclideanDimensions: 4 };
const keywordId = (label: string) => testUuid(`keyword:${label}`);
const ranking = (id: string, anchorId: string, candidates: string[]): RankingJudgment => ({ id: testUuid(`judgment:${id}`), anchorId: keywordId(anchorId), groups: candidates.map(id => [keywordId(id)]), confidence: 1, createdAt: 1 });
async function populate(store: LabbyStore, prefix = ''): Promise<KeywordVector[]> {
  const vectors: KeywordVector[] = [];
  for (let i = 0; i < 6; i++) {
    const id = keywordId(`${prefix}${i}`);
    await store.putKeyword({ id, name: id, names: {}, metadata: {} });
    vectors.push({ keywordId: id, geometry: { ...geometry }, embedding: Array.from({ length: 8 }, (_, k) => Math.sin(i + k) / 4), x: 0, y: 0, updatedAt: 1 });
  }
  await store.putKeywordVectors(vectors);
  return vectors;
}

test('ranking commit rolls back both vector updates and history replacement on an SQL failure', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    const vectors = await populate(store);
    const previous = ranking('previous', '0', ['1', '2']);
    await store.commitRanking([], [previous]);
    const before = (await store.exportBackupSnapshot()).tables;
    const changed = { ...vectors[0]!, embedding: vectors[0]!.embedding.map(n => n + 0.2), updatedAt: 2 };
    const duplicate = ranking('duplicate', '0', ['3', '4']);
    // Valid judgments reach SQL, then duplicate IDs fail after the vector update and DELETE history.
    await assert.rejects(store.commitRanking([changed], [duplicate, duplicate]));
    assert.deepEqual((await store.exportBackupSnapshot()).tables, before);
    await store.commitRanking([changed], [previous]);
    assert.deepEqual(await store.getKeywordVector(keywordId('0')), changed);
  } finally { await store.close(); }
});

test('forget preserves coordinates and keyword deletion removes only involved judgments and its vector', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    await populate(store);
    const forgotten = ranking('forget', '0', ['1', '2']);
    const anchorDeleted = ranking('anchor', '1', ['2', '3']);
    const candidateDeleted = ranking('candidate', '2', ['1', '3']);
    const unaffected = ranking('unaffected', '3', ['4', '5']);
    await store.commitRanking([], [forgotten, anchorDeleted, candidateDeleted, unaffected]);
    const before = await store.listKeywordVectors();
    await store.forgetRankingJudgment(testUuid('judgment:forget'));
    assert.deepEqual(await store.listKeywordVectors(), before);
    assert.deepEqual(
      await store.getRankingHistory(),
      [anchorDeleted, candidateDeleted, unaffected].sort((a, b) => a.id.localeCompare(b.id)),
    );
    await store.forgetRankingJudgment(testUuid('judgment:does-not-exist'));
    assert.deepEqual(await store.listKeywordVectors(), before);
    await store.deleteKeyword(keywordId('1'));
    assert.equal(await store.getKeyword(keywordId('1')), undefined);
    assert.equal(await store.getKeywordVector(keywordId('1')), undefined);
    assert.deepEqual(await store.getRankingHistory(), [unaffected]);
    assert.deepEqual(await store.listKeywordVectors(), before.filter(v => v.keywordId !== keywordId('1')));
  } finally { await store.close(); }
});

test('backup v2 restores history and archive; prevalidation and late SQL failures preserve the entire target', async () => {
  const source = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  const target = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    await populate(source);
    await populate(target, 'target-');
    const j = ranking('source-history', '0', ['1', '2']);
    await source.commitRanking([], [j]);
    const backup = await source.exportBackupSnapshot();
    const archived = { keyword_id: keywordId('legacy'), source: JSON.stringify({ keyword_id: 'legacy', vector64: [1, 2, 3], payload: { old: true } }), archived_at: '2026-01-01T00:00:00.000Z' };
    backup.tables.embeddingMigrationArchive.push(archived);
    await target.restoreBackupSnapshot(backup);
    assert.deepEqual(await target.getRankingHistory(), [j]);
    assert.deepEqual(await target.listKeywordVectors(), await source.listKeywordVectors());
    const restoredArchive = (await target.exportBackupSnapshot()).tables.embeddingMigrationArchive;
    assert.equal(restoredArchive.length, 1);
    assert.equal(restoredArchive[0]!.keyword_id, archived.keyword_id);
    assert.deepEqual(JSON.parse(String(restoredArchive[0]!.source)), JSON.parse(archived.source));
    assert.equal(new Date(String(restoredArchive[0]!.archived_at)).getTime(), new Date(archived.archived_at).getTime());
    assert.equal(await target.getKeyword(keywordId('target-0')), undefined);
    const before = (await target.exportBackupSnapshot()).tables;

    const invalidEmbedding = structuredClone(backup);
    invalidEmbedding.tables.keywordVectors[0]!.payload = JSON.stringify({ keywordId: keywordId('0'), geometry, embedding: [0], x: 0, y: 0, updatedAt: 1 });
    await assert.rejects(target.restoreBackupSnapshot(invalidEmbedding));
    assert.deepEqual((await target.exportBackupSnapshot()).tables, before);

    const sqlFailure = structuredClone(backup);
    sqlFailure.tables.embeddingMigrationArchive.push({ ...archived });
    // Archive primary-key collision occurs after DELETE and insertion of keywords/vectors/history.
    await assert.rejects(target.restoreBackupSnapshot(sqlFailure));
    assert.deepEqual((await target.exportBackupSnapshot()).tables, before);
    const invalidVersion = { ...backup, version: 1 };
    await assert.rejects(target.restoreBackupSnapshot(invalidVersion));
    assert.deepEqual((await target.exportBackupSnapshot()).tables, before);
  } finally { await source.close(); await target.close(); }
});

test('similarity lock serializes asynchronous writers and remains usable after failure', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    await store.listKeywords();
    const events: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = store.withSimilarityLock(async () => { events.push('first-start'); entered(); await gate; events.push('first-end'); });
    await started;
    const second = store.withSimilarityLock(async () => { events.push('second'); });
    await Promise.resolve();
    assert.deepEqual(events, ['first-start']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
    await assert.rejects(store.withSimilarityLock(async () => { throw new Error('expected'); }));
    await store.withSimilarityLock(async () => { events.push('recovered'); });
    assert.equal(events.at(-1), 'recovered');
    await store.withSimilarityLock(() => store.withSimilarityLock(async () => { events.push('nested'); }));
    assert.equal(events.at(-1), 'nested');
  } finally { await store.close(); }
});
