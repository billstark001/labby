import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateEuclideanVector } from '../src/db/migrate/003-projection.js';
import { BROWSER_SCHEMA_VERSION, upgradeBrowserSchema } from '../src/db/browser-migrations';

const schemaSql = {
  current: await readFile(new URL('../src/db/current-schema.sql', import.meta.url), 'utf8'),
  graph: await readFile(new URL('../src/db/migrate/004.up.sql', import.meta.url), 'utf8'),
  identity: await readFile(new URL('../src/db/migrate/005.up.sql', import.meta.url), 'utf8'),
  constraints: await readFile(new URL('../src/db/migrate/006.up.sql', import.meta.url), 'utf8'),
  localization: await readFile(new URL('../src/db/migrate/007.up.sql', import.meta.url), 'utf8'),
};
const KEYWORD_ID = '10000000-0000-4000-8000-000000000001';

async function legacyDatabase(db: PGlite, vector64 = Array.from({ length: 64 }, (_, i) => i / 64)) {
  await db.exec(`
    CREATE TABLE app_metadata (key text PRIMARY KEY,value jsonb NOT NULL);
    INSERT INTO app_metadata VALUES ('schema-version','{"version":2}');
    CREATE TABLE entities(kind text NOT NULL,id text NOT NULL,updated_at bigint NOT NULL DEFAULT 0,payload jsonb NOT NULL,PRIMARY KEY(kind,id));
    CREATE INDEX entities_kind_updated_idx ON entities(kind,updated_at DESC,id);
    INSERT INTO entities VALUES ('person','p',7,'{"name":"Keep me"}');
  `);
  const payload = { keywordId: 'k', vector64, x: 12, y: -7, updatedAt: 99, metadata: { preserve: 'raw' } };
  await db.query('INSERT INTO entities VALUES ($1,$2,$3,$4::jsonb)', ['keyword-vector', 'k', 99, JSON.stringify(payload)]);
  return payload;
}

test('fresh browser schema is initialized once and preserves data on repeated upgrades', async () => {
  const db = new PGlite();
  try {
    await upgradeBrowserSchema(db, schemaSql);
    assert.deepEqual((await db.query('SELECT value FROM app_metadata')).rows, [{ value: { version: BROWSER_SCHEMA_VERSION } }]);
    await db.query('INSERT INTO entities VALUES (\'keyword\',$1,$2,\'{"name":"Keep"}\')', [KEYWORD_ID, new Date(1)]);
    await upgradeBrowserSchema(db, schemaSql);
    assert.deepEqual((await db.query('SELECT payload FROM entities')).rows, [{ payload: { name: 'Keep' } }]);
    assert.deepEqual((await db.query('SELECT * FROM embedding_migration_archive')).rows, []);
  } finally { await db.close(); }
});

test('v5 browser constraints migrate to canonical tag selectors', async () => {
  const db = new PGlite();
  try {
    await upgradeBrowserSchema(db, schemaSql);
    await db.query("UPDATE app_metadata SET value='{\"version\":5}'::jsonb WHERE key='schema-version'");
    const id = '10000000-0000-4000-8000-000000000002';
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['constraint', id, new Date(1), JSON.stringify({ id, configId: '', type: 'no-overlap', personIds: [], weight: 4 })]);
    await upgradeBrowserSchema(db, schemaSql);
    const row = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM entities WHERE kind='constraint'")).rows[0]!;
    assert.deepEqual(row.payload.tagIds, []);
    assert.equal('weight' in row.payload, false);
  } finally { await db.close(); }
});

test('v6 browser records gain localized tag names and enabled constraints', async () => {
  const db = new PGlite();
  try {
    await upgradeBrowserSchema(db, schemaSql);
    await db.query("UPDATE app_metadata SET value='{\"version\":6}'::jsonb WHERE key='schema-version'");
    const tagId = '10000000-0000-4000-8000-000000000003';
    const constraintId = '10000000-0000-4000-8000-000000000004';
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['person-tag', tagId, new Date(1), JSON.stringify({ id: tagId, name: 'Local', color: '#336699' })]);
    await db.query('INSERT INTO entities(kind,id,updated_at,payload) VALUES($1,$2,$3,$4::jsonb)',
      ['constraint', constraintId, new Date(1), JSON.stringify({ id: constraintId, type: 'no-overlap', personIds: [], tagIds: [] })]);
    await upgradeBrowserSchema(db, schemaSql);
    const rows = (await db.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind,payload FROM entities WHERE kind IN ('person-tag','constraint') ORDER BY kind",
    )).rows;
    assert.equal(rows[0]?.payload.disabled, false);
    assert.deepEqual(rows[1]?.payload.names, { en: 'Local', zh: '', ja: '' });
  } finally { await db.close(); }
});

test('v2 browser vectors become product embeddings with verbatim payload archives', async () => {
  const db = new PGlite();
  try {
    const before = await legacyDatabase(db);
    await upgradeBrowserSchema(db, schemaSql);
    const expected = migrateEuclideanVector(before);
    const vectorRow = (await db.query<{ id: string; payload: typeof expected }>("SELECT id,payload FROM entities WHERE kind='keyword-vector'")).rows[0]!;
    assert.match(vectorRow.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(vectorRow.payload, { ...expected, keywordId: vectorRow.id });
    assert.equal(new Date((await db.query<{ updated_at: string }>("SELECT updated_at FROM entities WHERE kind='keyword-vector'")).rows[0]!.updated_at).getTime(), 99);
    const archive = (await db.query<{keyword_id:string;source:any}>('SELECT keyword_id,source FROM embedding_migration_archive')).rows[0]!;
    assert.equal(archive.keyword_id, vectorRow.id);
    assert.deepEqual(archive.source, before);
    assert.deepEqual((await db.query("SELECT payload FROM entities WHERE kind='person'")).rows, [{ payload: { name: 'Keep me' } }]);
    const snapshot = (await db.query('SELECT * FROM entities ORDER BY kind,id')).rows;
    await upgradeBrowserSchema(db, schemaSql);
    assert.deepEqual((await db.query('SELECT * FROM entities ORDER BY kind,id')).rows, snapshot);
    assert.equal((await db.query('SELECT keyword_id FROM embedding_migration_archive')).rows.length, 1);
  } finally { await db.close(); }
});

test('malformed browser vector rolls back conversion, archive and version', async () => {
  const db = new PGlite();
  try {
    await legacyDatabase(db);
    await db.query('INSERT INTO entities VALUES ($1,$2,$3,$4::jsonb)', ['keyword-vector', 'z', 99, JSON.stringify({ keywordId: 'z', vector64: [1, 2, 3], updatedAt: 99 })]);
    const before = (await db.query('SELECT * FROM entities ORDER BY kind,id')).rows;
    await assert.rejects(upgradeBrowserSchema(db, schemaSql), /malformed Euclidean keyword vector/);
    assert.deepEqual((await db.query('SELECT * FROM entities ORDER BY kind,id')).rows, before);
    assert.deepEqual((await db.query('SELECT value FROM app_metadata')).rows, [{ value: { version: 2 } }]);
    assert.deepEqual((await db.query("SELECT to_regclass('embedding_migration_archive') AS archive")).rows, [{ archive: null }]);
  } finally { await db.close(); }
});

test('unknown newer browser schema is rejected without altering its contents', async () => {
  const db = new PGlite();
  try {
    await legacyDatabase(db);
    await db.query("UPDATE app_metadata SET value=$1::jsonb WHERE key='schema-version'", [JSON.stringify({ version: BROWSER_SCHEMA_VERSION + 1 })]);
    const before = (await db.query('SELECT * FROM entities ORDER BY kind,id')).rows;
    await assert.rejects(upgradeBrowserSchema(db, schemaSql), /newer than supported/);
    assert.deepEqual((await db.query('SELECT * FROM entities ORDER BY kind,id')).rows, before);
    assert.deepEqual((await db.query('SELECT value FROM app_metadata')).rows, [{ value: { version: BROWSER_SCHEMA_VERSION + 1 } }]);
  } finally { await db.close(); }
});


test('maintenance notices distinguish fresh init, migration and unchanged startup', async () => {
  const db = new PGlite();
  const notices: string[] = [];
  try {
    assert.equal(await upgradeBrowserSchema(db, schemaSql, kind => notices.push(kind)), true);
    assert.deepEqual(notices, ['initialize']);
    assert.equal(await upgradeBrowserSchema(db, schemaSql, kind => notices.push(kind)), false);
    assert.deepEqual(notices, ['initialize']);
  } finally { await db.close(); }
});

test('browser graph cursor feed reports deletes and equal-timestamp updates', async () => {
  const db = new PGlite();
  try {
    await upgradeBrowserSchema(db, schemaSql);
    const { listBrowserGraphPage } = await import('../src/db/graph.js');
    const first = await listBrowserGraphPage(db);
    await db.query('INSERT INTO entities VALUES($1,$2,$3,$4)', ['keyword',KEYWORD_ID,new Date(1),JSON.stringify({id:KEYWORD_ID,name:'before'})]);
    const added = await listBrowserGraphPage(db, { since: first.checkpoint! });
    assert.equal(added.items[0]!.keyword!.name, 'before');
    await db.query('UPDATE entities SET payload=$1 WHERE kind=$2 AND id=$3', [JSON.stringify({id:KEYWORD_ID,name:'after'}),'keyword',KEYWORD_ID]);
    const changed = await listBrowserGraphPage(db, { since: added.checkpoint! });
    assert.equal(changed.items[0]!.keyword!.name, 'after');
    await db.query('DELETE FROM entities WHERE kind=$1 AND id=$2', ['keyword',KEYWORD_ID]);
    const removed = await listBrowserGraphPage(db, { since: changed.checkpoint! });
    assert.equal(removed.items[0]!.keyword, null);
  } finally { await db.close(); }
});
