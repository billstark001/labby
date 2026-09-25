import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildEntityPageQueries, listGraphPage, readBusinessRecord, SCHEMA_VERSION,
  upsertConstraint, upsertKeyword, upsertKeywordVector, upsertPerson, upsertPersonTag,
  upsertSchedule, upsertUnavailability,
} from '@labby/db';
import { migrateBrowserToSharedSchema } from '../src/db/migrate/010-to-shared';
import { upgradeSharedSchema } from '../src/db/shared-migrations';
import { importLegacyIndexedDbDump } from '../src/db/migrate/legacy-idb-import';
import { upgradeBrowserSchema } from '../src/db/browser-migrations';

const schema = await readFile(new URL('../../db/current-schema.sql', import.meta.url), 'utf8');
const metadataSql = await readFile(new URL('../../db/migrate/011.up.sql', import.meta.url), 'utf8');
const legacySchema = await readFile(new URL('../src/db/migrate/legacy-current-schema.sql', import.meta.url), 'utf8');
const id = '10000000-0000-4000-8000-000000000001';
const keyword = { id, name: 'Keep', names: { en: 'Keep' }, metadata: {}, modifiedAt: 7 };
const vector = {
  keywordId: id, x: 1, y: 2, embedding: Array(8).fill(0),
  geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 }, updatedAt: 9,
};
const legacyUpgrades = {
  current: legacySchema,
  graph: await readFile(new URL('../src/db/migrate/004.up.sql', import.meta.url), 'utf8'),
  identity: await readFile(new URL('../src/db/migrate/005.up.sql', import.meta.url), 'utf8'),
  constraints: await readFile(new URL('../src/db/migrate/006.up.sql', import.meta.url), 'utf8'),
  localization: await readFile(new URL('../src/db/migrate/007.up.sql', import.meta.url), 'utf8'),
  unavailability: await readFile(new URL('../src/db/migrate/008.up.sql', import.meta.url), 'utf8'),
  pairGroups: await readFile(new URL('../src/db/migrate/009.up.sql', import.meta.url), 'utf8'),
};

test('browser PGlite uses the exact canonical schema and shared graph query', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await upsertKeyword(db, keyword);
    await upsertKeywordVector(db, vector);
    assert.deepEqual(await readBusinessRecord(db, 'keyword-vector', id), vector);
    assert.equal((await listGraphPage(db)).items[0]?.keyword?.name, 'Keep');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]?.n, SCHEMA_VERSION);
  } finally { await db.close(); }
});

test('existing browser PGlite rows, archive and import marker convert transactionally', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['keyword', id, new Date(7), JSON.stringify(keyword)]);
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['keyword-vector', id, new Date(9), JSON.stringify(vector)]);
    await db.query('INSERT INTO embedding_migration_archive(keyword_id,source) VALUES($1,$2::jsonb)',
      [id, JSON.stringify({ old: true })]);
    await db.query('INSERT INTO app_metadata(key,value) VALUES($1,$2::jsonb)',
      ['legacy-idb-v6-import', JSON.stringify({ records: 2 })]);
    await migrateBrowserToSharedSchema(db, schema);
    assert.equal((await db.query("SELECT to_regclass('public.entities') AS old")).rows[0]?.old, null);
    assert.deepEqual(await readBusinessRecord(db, 'keyword', id), keyword);
    assert.deepEqual(await readBusinessRecord(db, 'keyword-vector', id), vector);
    assert.equal((await db.query('SELECT source FROM embedding_migration_archive')).rows[0]?.source?.old, true);
    assert.equal((await db.query("SELECT value FROM app_metadata WHERE key='legacy-idb-v6-import'")).rows[0]?.value?.records, 2);
    assert.equal((await listGraphPage(db)).items[0]?.id, id);
  } finally { await db.close(); }
});

test('invalid former browser rows leave the old database intact', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['keyword-vector', id, new Date(9), JSON.stringify({ ...vector, embedding: [0] })]);
    await assert.rejects(migrateBrowserToSharedSchema(db, schema));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM entities')).rows[0]?.n, 1);
    assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS current")).rows[0]?.current, null);
  } finally { await db.close(); }
});

test('both runtimes apply the same subsequent SQL migration', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await db.exec('DROP TABLE app_metadata; DELETE FROM schema_migrations WHERE version=11');
    assert.equal(await upgradeSharedSchema(db, { metadata: metadataSql }), true);
    assert.equal((await db.query("SELECT to_regclass('public.app_metadata') AS table_name")).rows[0]?.table_name, 'app_metadata');
    assert.equal(await upgradeSharedSchema(db, { metadata: metadataSql }), false);
  } finally { await db.close(); }
});

test('one-time IndexedDB import writes canonical tables and rewrites linked IDs', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    await importLegacyIndexedDbDump(db, {
      persons: [{ id: 'old-person', name: 'P', names: {}, metadata: {}, keywordIds: ['old-keyword'], modifiedAt: 5 }],
      personTags: [],
      keywords: [{ id: 'old-keyword', name: 'K', names: {}, metadata: {}, modifiedAt: 6 }],
      keywordVectors: [{ ...vector, keywordId: 'old-keyword' }],
      rankingHistory: [], configs: [], constraints: [], schedules: [], unavailabilities: [], emailTasks: [],
      embeddingMigrationArchive: [{ keywordId: 'old-keyword', source: { original: true } }],
    });
    const person = (await db.query('SELECT id,payload FROM persons')).rows[0]!;
    const savedKeyword = (await db.query('SELECT id FROM keywords')).rows[0]!;
    assert.match(String(person.id), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.deepEqual(person.payload.keywordIds, [savedKeyword.id]);
    assert.equal((await db.query('SELECT keyword_id FROM keyword_vectors')).rows[0]?.keyword_id, savedKeyword.id);
    assert.equal((await db.query('SELECT keyword_id FROM embedding_migration_archive')).rows[0]?.keyword_id, savedKeyword.id);
    await importLegacyIndexedDbDump(db, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM persons')).rows[0]?.n, 1);
  } finally { await db.close(); }
});

test('shared person pagination uses indexed relational rows and tag names', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    const tagId = '10000000-0000-4000-8000-000000000004';
    await upsertPersonTag(db, { id: tagId, name: 'Alpha', names: { en: 'Alpha' }, color: '#123456' });
    await upsertPerson(db, { id, name: 'B', names: { en: 'B' }, metadata: {}, keywordIds: [], tagIds: [tagId] });
    await upsertPerson(db, { id: '10000000-0000-4000-8000-000000000005', name: 'A', names: { en: 'A' }, metadata: {}, keywordIds: [], tagIds: [] });
    const { pageSql, countSql } = buildEntityPageQueries('persons',
      { offset: 0, limit: 1, sortBy: 'tags', sortDirection: 'asc' }, '"C"');
    assert.equal((await db.query(countSql)).rows[0]?.total, 2);
    assert.equal((await db.query(pageSql)).rows[0]?.payload?.id, id);
  } finally { await db.close(); }
});

test('older browser document schema upgrades through its history into shared tables', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_metadata(key text PRIMARY KEY,value jsonb NOT NULL);
      INSERT INTO app_metadata VALUES('schema-version','{"version":2}');
      CREATE TABLE entities(kind text NOT NULL,id text NOT NULL,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX entities_kind_updated_idx ON entities(kind,updated_at DESC,id);
    `);
    await db.query('INSERT INTO entities VALUES($1,$2,$3,$4::jsonb)',
      ['keyword', 'old-keyword', 6, JSON.stringify({ id: 'old-keyword', name: 'Old' })]);
    await db.query('INSERT INTO entities VALUES($1,$2,$3,$4::jsonb)',
      ['keyword-vector', 'old-keyword', 9, JSON.stringify({ keywordId: 'old-keyword', vector64: Array(64).fill(0), updatedAt: 9 })]);
    await db.query('INSERT INTO entities VALUES($1,$2,$3,$4::jsonb)',
      ['person', 'old-person', 5, JSON.stringify({ id: 'old-person', name: 'Old person', keywordIds: ['old-keyword'] })]);
    await upgradeBrowserSchema(db, legacyUpgrades);
    await migrateBrowserToSharedSchema(db, schema);
    const keywordId = (await db.query('SELECT id FROM keywords')).rows[0]?.id;
    assert.equal((await db.query('SELECT keyword_id FROM keyword_vectors')).rows[0]?.keyword_id, keywordId);
    assert.deepEqual((await db.query('SELECT keyword_ids FROM persons')).rows[0]?.keyword_ids, [keywordId]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM embedding_migration_archive')).rows[0]?.n, 1);
  } finally { await db.close(); }
});

test('shared writers keep scheduling selector columns aligned with JSON payloads', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    const tagId = '10000000-0000-4000-8000-000000000006';
    await upsertConstraint(db, {
      id, type: 'no-overlap', configId: '', groups: [{ personIds: [id], tagIds: [tagId] }], modifiedAt: 5,
    });
    await upsertSchedule(db, {
      id, configId: tagId, createdAt: 1, modifiedAt: 2,
      sessions: [{ date: '2026-01-01', presentations: [{ presenterId: id, questionerIds: [tagId] }] }],
    });
    await upsertUnavailability(db, {
      id, configId: tagId, personIds: [id], tagIds: [tagId], allPeople: false,
      startDate: '2026-01-01', endDate: '2026-01-02',
    });
    assert.deepEqual((await db.query('SELECT person_ids,tag_ids FROM constraints')).rows[0],
      { person_ids: [id], tag_ids: [tagId] });
    assert.deepEqual((await db.query('SELECT person_ids FROM schedules')).rows[0]?.person_ids, [id, tagId]);
    assert.deepEqual((await db.query('SELECT person_ids,tag_ids,all_people FROM unavailabilities')).rows[0],
      { person_ids: [id], tag_ids: [tagId], all_people: false });
  } finally { await db.close(); }
});
