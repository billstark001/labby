import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseDump } from '@labby/core';

import { legacyDumpToEntityRows, LEGACY_IDB_VERSION } from '../src/db/legacy-idb-upgrade';
import { pendingBrowserSchemaVersions } from '../src/db/pglite';

test('legacy IndexedDB upgrade uses a new version and normalizes the complete dump', () => {
  assert.equal(LEGACY_IDB_VERSION, 6);
  const dump: DatabaseDump = {
    persons: [{ id: 'p', name: 'P', names: {}, keywordIds: [], metadata: {}, modifiedAt: 7 }],
    keywords: [{ id: 'k', name: 'K', modifiedAt: 8 }],
    keywordVectors: [{ keywordId: 'k', vector64: new Float32Array([0.25, 0.5]) as unknown as number[], x: 1, y: 2, updatedAt: 9 }],
    configs: [],
    constraints: [],
    schedules: [],
    unavailabilities: [{ id: 'u', configId: 'c', personId: 'p', date: '2026-01-01' }],
    emailTasks: [],
  };

  const rows = legacyDumpToEntityRows(dump);
  assert.deepEqual(rows.map(item => item.kind), ['person', 'keyword', 'keyword-vector', 'unavailability']);
  assert.deepEqual((rows[2]!.payload as { vector64: number[] }).vector64, [0.25, 0.5]);
  assert.deepEqual((rows[3]!.payload as { personIds: string[] }).personIds, ['p']);
  assert.equal(rows[0]!.updated_at, 7);
});

test('browser schema upgrades are ordered and reject newer databases', () => {
  assert.deepEqual(pendingBrowserSchemaVersions(0), [1, 2]);
  assert.deepEqual(pendingBrowserSchemaVersions(1), [2]);
  assert.deepEqual(pendingBrowserSchemaVersions(2), []);
  assert.throws(() => pendingBrowserSchemaVersions(3), /newer than supported/);
});
