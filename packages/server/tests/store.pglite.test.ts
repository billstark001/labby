import { createTestStore } from './support/database.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  EmailTask,
  Keyword,
  KeywordVector,
  Person,
  PersonUnavailability,
  ScheduleConfig,
  SchedulePlan,
} from '@labby/core';
import { LabbyStore, UserRole, type RefreshTokenRecord, type StoredUser } from '../src/store/index';

function testUuid(seed: string): string {
  const hex = [...seed].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000001`;
}

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

function samplePerson(id = testUuid('p1')): Person {
  return {
    id,
    name: `Person ${id}`,
    names: { en: `Person ${id}` },
    metadata: {},
    keywordIds: [testUuid('k1')],
  };
}

function sampleKeyword(id = testUuid('k1')): Keyword {
  return {
    id,
    name: `Keyword ${id}`,
    names: { en: `Keyword ${id}` },
    metadata: {},
  };
}

function sampleConfig(id = testUuid('c1')): ScheduleConfig {
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

function samplePlan(id = testUuid('s1'), configId = testUuid('c1')): SchedulePlan {
  return {
    id,
    configId,
    createdAt: Date.now(),
    sessions: [
      {
        date: '2026-01-02',
        presentations: [{ presenterId: testUuid('p1'), questionerIds: [testUuid('p2')] }],
      },
    ],
  };
}

function sampleUnavailability(id = testUuid('u1'), personId = testUuid('p1'), configId = testUuid('c1')): PersonUnavailability {
  return {
    id,
    personIds: [personId],
    tagIds: [],
    allPeople: false,
    configId,
    startDate: '2026-01-03',
    endDate: '2026-01-04',
  };
}

function sampleVector(keywordId = testUuid('k1')): KeywordVector {
  const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 0.5 : 0));
  return {
    keywordId,
    embedding,
    geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 },
    x: embedding[0] ?? 0,
    y: embedding[1] ?? 0,
    updatedAt: Date.now(),
  };
}

function sampleEmailTask(id = testUuid('et1'), configId = testUuid('c1')): EmailTask {
  return {
    id,
    configId,
    daysOfWeek: [1, 3, 5],
    emails: ['foo@example.com', 'bar@example.com'],
    recentTimes: 0,
    templateText: 'Hello {{ user.name }}',
    sentCounts: {},
    metadata: {},
  };
}

function sampleUser(id = testUuid('user-1')): StoredUser {
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

function sampleRefreshToken(userId = testUuid('user-1')): RefreshTokenRecord {
  const now = Date.now();
  return {
    tokenId: testUuid('token-1'),
    userId,
    createdAt: now,
    expiresAt: now + 60_000,
    revokedAt: null,
    replacedByTokenId: null,
  };
}

test('LabbyStore initializes and supports core CRUD', async () => {
  const dbPath = createTempDbPath('labby-store-crud');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });

  try {
    const person = samplePerson();
    const keyword = sampleKeyword();
    const config = sampleConfig();
    const plan = samplePlan();
    const unavailability = sampleUnavailability();
    const vector = sampleVector();
    const emailTask = sampleEmailTask();
    const user = sampleUser();
    const token = sampleRefreshToken(user.id);
    const tag = { id: testUuid('tag-1'), name: 'Core team', names: { en: 'Core team', zh: '', ja: '' }, color: '#336699', notes: 'test' };
    person.tagIds = [tag.id];

    await store.putPersonTag(tag);
    await store.putPerson(person);
    await store.putPerson(samplePerson(testUuid('p2')));
    await store.putKeyword(keyword);
    await store.putConfig(config);
    const invalidPlan = samplePlan(testUuid('s-invalid'));
    invalidPlan.sessions[0]!.presentations[0]!.questionerIds = [testUuid('p1')];
    await assert.rejects(() => store.putSchedule(invalidPlan), /self-questioning/);
    assert.equal(await store.getSchedule(invalidPlan.id), undefined);
    await store.putSchedule(plan);
    await store.putUnavailability(unavailability);
    const everyone = { ...sampleUnavailability(testUuid('all-people')), personIds: [], allPeople: true };
    await store.putUnavailability(everyone);
    await store.putKeywordVector(vector);
    await store.putEmailTask(emailTask);
    await store.createUser(user);
    await store.saveRefreshToken(token);

    assert.equal((await store.getPerson(person.id))?.id, person.id);
    const requestMetrics = { dbQueries: 0, dbDurationMs: 0 };
    await store.withRequestMetrics(requestMetrics, () => store.getPerson(person.id));
    assert.equal(requestMetrics.dbQueries, 1);
    assert.ok(requestMetrics.dbDurationMs >= 0);
    assert.equal((await store.getPersonTag(tag.id))?.color, '#336699');
    assert.equal((await store.getKeyword(keyword.id))?.id, keyword.id);
    assert.equal((await store.getConfig(config.id))?.id, config.id);
    assert.equal((await store.getSchedule(plan.id))?.id, plan.id);
    assert.equal((await store.getUnavailability(unavailability.id))?.id, unavailability.id);
    const everyoneRow = (await store.exportBackupSnapshot()).tables.unavailabilities.find(row => row.id === everyone.id);
    assert.equal(Boolean(everyoneRow?.all_people), true);
    assert.deepEqual(JSON.parse(String(everyoneRow?.payload)).personIds, []);
    assert.equal((await store.getKeywordVector(vector.keywordId))?.keywordId, vector.keywordId);
    assert.equal((await store.getKeywordVectors([vector.keywordId])).length, 1);
    assert.equal((await store.getEmailTask(emailTask.id))?.id, emailTask.id);
    assert.equal((await store.findUserByIdentity('ALICE'))?.id, user.id);
    assert.equal((await store.getRefreshToken(token.tokenId))?.tokenId, token.tokenId);
    await store.deletePersonTag(tag.id);
    assert.deepEqual((await store.getPerson(person.id))?.tagIds, []);
  } finally {
    await store.close();
  }
});

test('LabbyStore snapshot export and restore keeps data', async () => {
  const sourcePath = createTempDbPath('labby-store-source');
  const targetPath = createTempDbPath('labby-store-target');
  const source = await createTestStore({ dialect: 'pglite', dataDir: sourcePath });
  const target = await createTestStore({ dialect: 'pglite', dataDir: targetPath });

  try {
    await source.putPerson(samplePerson(testUuid('p-a')));
    const tagId = testUuid('tag-backup');
    await source.putPersonTag({ id: tagId, name: 'Local', names: { en: 'Local', zh: '', ja: '' }, color: '#336699' });
    await source.putKeyword(sampleKeyword(testUuid('k-a')));
    await source.putKeywordVector(sampleVector(testUuid('k-a')));
    await source.putKeyword(sampleKeyword(testUuid('k-b')));
    await source.putKeywordVector(sampleVector(testUuid('k-b')));
    await source.putUnavailability({ ...sampleUnavailability(testUuid('backup-all')), personIds: [], allPeople: true });

    const graph = await source.listGraph();
    assert.equal(graph.items.filter(item => item.keyword).length, 2);
    assert.equal(graph.items.filter(item => item.vector).length, 2);
    assert.ok(graph.checkpoint);

    const snapshot = await source.exportBackupSnapshot();
    assert.equal(snapshot.version, 3);
    const legacyTag = JSON.parse(String(snapshot.tables.personTags[0]!.payload));
    delete legacyTag.names;
    snapshot.tables.personTags[0]!.payload = JSON.stringify(legacyTag);
    assert.deepEqual(snapshot.tables.rankingJudgments, []);
    assert.deepEqual(snapshot.tables.embeddingMigrationArchive, []);
    await target.restoreBackupSnapshot(snapshot);

    assert.equal((await target.listPersons()).length, 1);
    assert.deepEqual((await target.getPersonTag(tagId))?.names, { en: 'Local', zh: '', ja: '' });
    assert.equal((await target.listKeywords()).length, 2);
    assert.equal((await target.listKeywordVectors()).length, 2);
    assert.equal((await target.getUnavailability(testUuid('backup-all')))?.allPeople, true);
  } finally {
    await source.close();
    await target.close();
  }
});

test('LabbyStore keeps modifiedAt sorting and standalone constraints persistence', async () => {
  const dbPath = createTempDbPath('labby-store-order-constraints');
  const store = await createTestStore({ dialect: 'pglite', dataDir: dbPath });

  try {
    const older = samplePerson(testUuid('p-old'));
    older.name = 'Zulu';
    older.names.en = 'Zulu';
    older.names.zh = 'Alpha-localized';
    older.notes = 'later note';
    older.modifiedAt = 10;
    const newer = samplePerson(testUuid('p-new'));
    newer.name = 'Alpha';
    newer.names.en = 'Alpha';
    newer.names.zh = 'Zulu-localized';
    newer.notes = 'earlier note';
    newer.modifiedAt = 20;
    await store.putPerson(older);
    await store.putPerson(newer);

    const persons = await store.listPersons();
    assert.equal(persons[0]?.id, newer.id);
    assert.equal(persons[1]?.id, older.id);

    const personsByName = await store.listPersons({ sortBy: 'name', sortDirection: 'asc' });
    assert.equal(personsByName[0]?.id, newer.id);
    assert.equal(personsByName[1]?.id, older.id);
    const localizedPersons = await store.listPersonsPage({ offset: 0, limit: 2, sortBy: 'name', sortDirection: 'asc', locale: 'zh-CN' });
    assert.deepEqual(localizedPersons.items.map(person => person.id), [older.id, newer.id]);

    const personsByNotes = await store.listPersons({ sortBy: 'notes', sortDirection: 'asc' });
    assert.equal(personsByNotes[0]?.id, newer.id);
    assert.equal(personsByNotes[1]?.id, older.id);

    const alphaTag = { id: testUuid('tag-alpha'), name: 'Alpha team', names: { en: 'Alpha team', zh: '', ja: '' }, color: '#336699' };
    const zetaTag = { id: testUuid('tag-zeta'), name: 'Zeta team', names: { en: 'Zeta team', zh: '', ja: '' }, color: '#663399' };
    await store.putPersonTag(alphaTag);
    await store.putPersonTag(zetaTag);
    newer.tagIds = [alphaTag.id]; newer.disabled = true;
    older.tagIds = [zetaTag.id];
    await store.putPerson(newer);
    await store.putPerson(older);
    const byTag = await store.listPersonsPage({ offset: 0, limit: 1, sortBy: 'tags', sortDirection: 'asc' });
    assert.equal(byTag.total, 2);
    assert.deepEqual(byTag.items.map(person => person.id), [newer.id]);
    const byTagSecondPage = await store.listPersonsPage({ offset: 1, limit: 1, sortBy: 'tags', sortDirection: 'asc' });
    assert.deepEqual(byTagSecondPage.items.map(person => person.id), [older.id]);
    const byDisabled = await store.listPersonsPage({ offset: 0, limit: 2, sortBy: 'disabled', sortDirection: 'asc' });
    assert.deepEqual(byDisabled.items.map(person => person.id), [older.id, newer.id]);

    const keywordZeta = sampleKeyword(testUuid('k-zeta'));
    keywordZeta.name = 'Zeta';
    keywordZeta.names.en = 'Zeta';
    keywordZeta.notes = 'zzz';
    keywordZeta.modifiedAt = 5;
    const keywordAlpha = sampleKeyword(testUuid('k-alpha'));
    keywordAlpha.name = 'Alpha';
    keywordAlpha.names.en = 'Alpha';
    keywordAlpha.notes = 'aaa';
    keywordAlpha.modifiedAt = 15;
    await store.putKeyword(keywordZeta);
    await store.putKeyword(keywordAlpha);

    const keywordsByName = await store.listKeywords({ sortBy: 'name', sortDirection: 'asc' });
    assert.equal(keywordsByName[0]?.id, keywordAlpha.id);
    assert.equal(keywordsByName[1]?.id, keywordZeta.id);

    const keywordsByNotes = await store.listKeywords({ sortBy: 'notes', sortDirection: 'asc' });
    assert.equal(keywordsByNotes[0]?.id, keywordAlpha.id);
    assert.equal(keywordsByNotes[1]?.id, keywordZeta.id);

    const config = sampleConfig(testUuid('cfg-constraints'));
    await store.putConfig(config);

    await store.putConstraint({
      id: testUuid('constraint-1'),
      configId: config.id,
      type: 'no-overlap',
      personIds: [older.id, newer.id],
      tagIds: [],
    });
    await store.putConstraint({
      id: testUuid('constraint-2'),
      configId: config.id,
      type: 'frequency-multiplier',
      personIds: [newer.id],
      tagIds: [],
      baseline: 1,
      multiplier: 2,
      roleScope: 'presenter',
      weight: 1,
    });

    const loaded = await store.listConstraintsByConfig(config.id);
    assert.equal(loaded.length, 2);
    const types = new Set(loaded.map((item) => item.type));
    assert.equal(types.has('no-overlap'), true);
    assert.equal(types.has('frequency-multiplier'), true);
  } finally {
    await store.close();
  }
});

test('JSONB schedule foreign keys load presenters, questioners, constraints and unavailable people', async () => {
  const store = await createTestStore({dialect:'pglite',dataDir:'memory://'});
  try {
    await store.putKeyword(sampleKeyword());
    for (const id of ['p1','p2','p3','p4'].map(testUuid)) await store.putPerson(samplePerson(id));
    await store.putConfig(sampleConfig());
    await store.putSchedule(samplePlan());
    await store.putConstraint({id:testUuid('constraint'),configId:testUuid('c1'),type:'no-overlap',personIds:[testUuid('p3')],tagIds:[]});
    await store.putUnavailability(sampleUnavailability(testUuid('u1'),testUuid('p4')));
    const bundle=await store.listScheduleForeignKeys({configIds:[testUuid('c1')]});
    assert.deepEqual(bundle.persons.map(person=>person.id).sort(),['p1','p2','p3','p4'].map(testUuid).sort());
    assert.ok(bundle.persons.every(person=>person.name?.startsWith('Person')));
    assert.equal(bundle.keywords[0]?.id,testUuid('k1'));
    const references = await store.listPersonForeignKeys({ personIds: ['p1','p2','p3','p4'].map(testUuid) });
    assert.deepEqual(references.referencedPersonIds, ['p1','p2','p3','p4'].map(testUuid).sort());
  } finally {await store.close();}
});
