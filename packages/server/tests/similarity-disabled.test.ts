import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddingService } from '../src/lib/embedding-service.js';
import { createTestStore } from './support/database.js';

const ids = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
  '00000000-0000-4000-8000-000000000106',
];
const judgmentId = '00000000-0000-4000-8000-000000000201';

test('disabled keywords are opt-in for recommendations and ignored by training', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  const service = new EmbeddingService(store);
  try {
    for (const [index, id] of ids.entries())
      await store.putKeyword({ id, name: `keyword-${index}`, disabled: index === 5 });
    await service.start();

    const defaultQuery = await service.recommendRanking({ size: 5 });
    assert.ok(defaultQuery);
    assert.equal([defaultQuery.anchorId, ...defaultQuery.candidateIds].includes(ids[5]!), false);

    const inclusiveQuery = await service.recommendRanking({ size: 5, includeDisabled: true });
    assert.ok(inclusiveQuery);
    assert.equal([inclusiveQuery.anchorId, ...inclusiveQuery.candidateIds].includes(ids[5]!), true);

    const disabledBefore = await store.getKeywordVector(ids[5]!);
    const result = await service.trainRanking({
      id: judgmentId,
      anchorId: ids[0]!,
      groups: [[ids[1]!, ids[5]!], [ids[2]!]],
      confidence: 1,
      createdAt: 1,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(await store.getKeywordVector(ids[5]!), disabledBefore);
    assert.deepEqual((await store.getRankingHistory())[0]?.groups, [[ids[1]!], [ids[2]!]]);
  } finally {
    await service.shutdown();
    await store.close();
  }
});
