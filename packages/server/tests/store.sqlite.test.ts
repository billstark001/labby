import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  Keyword,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
  SimilarityEdge,
} from '@labby/core';
import { SqliteStore, UserRole, type RefreshTokenRecord, type StoredUser } from '../src/store/index.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

function samplePerson(id = 'p1'): Person {
  return {
    id,
    name: `Person ${id}`,
    names: { en: `Person ${id}` },
    metadata: {},
    keywordIds: ['k1'],
  };
}

function sampleKeyword(id = 'k1'): Keyword {
  return {
    id,
    name: `Keyword ${id}`,
    names: { en: `Keyword ${id}` },
    metadata: {},
  };
}

function sampleConfig(id = 'c1'): ScheduleConfig {
  return {
    id,
    daysOfWeek: [1],
    timeRange: ['09:00', '10:00'],
    presentersPerSession: 1,
    questionersPerPresenter: 1,
    targetSimilarityRadius: 0.5,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    metadata: {},
  };
}

function samplePlan(id = 's1', configId = 'c1'): SchedulePlan {
  return {
    id,
    configId,
    createdAt: Date.now(),
    sessions: [
      {
        date: '2026-01-02',
        presentations: [{ presenterId: 'p1', questionerIds: ['p2'] }],
      },
    ],
  };
}

function sampleUnavailability(id = 'u1', personId = 'p1', configId = 'c1'): PersonUnavailability {
  return {
    id,
    personId,
    configId,
    startDate: '2026-01-03',
    endDate: '2026-01-04',
  };
}

function sampleEdge(sourceId = 'k1', targetId = 'k2'): SimilarityEdge {
  return { sourceId, targetId, weight: 0.8 };
}

function sampleUser(id = 'user-1'): StoredUser {
  return {
    id,
    username: 'alice',
    email: 'alice@example.com',
    role: UserRole.Admin,
    passwordHash: 'hash',
    disabled: false,
    createdAt: Date.now(),
  };
}

function sampleRefreshToken(userId = 'user-1'): RefreshTokenRecord {
  const now = Date.now();
  return {
    tokenId: 'token-1',
    userId,
    createdAt: now,
    expiresAt: now + 60_000,
    revokedAt: null,
    replacedByTokenId: null,
  };
}

test('SqliteStore initializes and supports core CRUD', async () => {
  const dbPath = createTempDbPath('labby-store-crud');
  const store = new SqliteStore({ dialect: 'sqlite', path: dbPath });

  try {
    const person = samplePerson();
    const keyword = sampleKeyword();
    const config = sampleConfig();
    const plan = samplePlan();
    const unavailability = sampleUnavailability();
    const edge = sampleEdge();
    const user = sampleUser();
    const token = sampleRefreshToken(user.id);

    await store.putPerson(person);
    await store.putKeyword(keyword);
    await store.putConfig(config);
    await store.putSchedule(plan);
    await store.putUnavailability(unavailability);
    await store.putSimilarity(edge);
    await store.createUser(user);
    await store.saveRefreshToken(token);

    assert.equal((await store.getPerson(person.id))?.id, person.id);
    assert.equal((await store.getKeyword(keyword.id))?.id, keyword.id);
    assert.equal((await store.getConfig(config.id))?.id, config.id);
    assert.equal((await store.getSchedule(plan.id))?.id, plan.id);
    assert.equal((await store.getUnavailability(unavailability.id))?.id, unavailability.id);
    assert.equal((await store.getSimilarity('k2', 'k1'))?.weight, 0.8);
    assert.equal((await store.findUserByIdentity('ALICE'))?.id, user.id);
    assert.equal((await store.getRefreshToken(token.tokenId))?.tokenId, token.tokenId);
  } finally {
    await store.close();
  }
});

test('SqliteStore snapshot export and restore keeps data', async () => {
  const sourcePath = createTempDbPath('labby-store-source');
  const targetPath = createTempDbPath('labby-store-target');
  const source = new SqliteStore({ dialect: 'sqlite', path: sourcePath });
  const target = new SqliteStore({ dialect: 'sqlite', path: targetPath });

  try {
    await source.putPerson(samplePerson('p-a'));
    await source.putKeyword(sampleKeyword('k-a'));
    await source.putSimilarity(sampleEdge('k-a', 'k-b'));

    const snapshot = await source.exportBackupSnapshot();
    await target.restoreBackupSnapshot(snapshot);

    assert.equal((await target.listPersons()).length, 1);
    assert.equal((await target.listKeywords()).length, 1);
    assert.equal((await target.listSimilarities()).length, 1);
  } finally {
    await source.close();
    await target.close();
  }
});

test('SqliteStore binary backup and restore from sqlite file works', async () => {
  const sourcePath = createTempDbPath('labby-store-bak-source');
  const targetPath = createTempDbPath('labby-store-bak-target');
  const backupPath = createTempDbPath('labby-store-bak-file');

  const source = new SqliteStore({ dialect: 'sqlite', path: sourcePath });
  const target = new SqliteStore({ dialect: 'sqlite', path: targetPath });

  try {
    await source.putPerson(samplePerson('p-b'));
    await source.putConfig(sampleConfig('c-b'));

    await source.backupDatabase(backupPath);
    await target.restoreFromSqliteFile(backupPath);

    assert.equal((await target.getPerson('p-b'))?.id, 'p-b');
    assert.equal((await target.getConfig('c-b'))?.id, 'c-b');
  } finally {
    await source.close();
    await target.close();
  }
});
