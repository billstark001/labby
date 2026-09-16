import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateEuclideanVector } from '../src/db/migrate/003-projection.js';
import { BROWSER_SCHEMA_VERSION, upgradeBrowserSchema } from '../src/db/browser-migrations';

const schemaSql = {
  current: await readFile(new URL('../src/db/current-schema.sql', import.meta.url), 'utf8'),
  graph: await readFile(new URL('../src/db/migrate/004.up.sql', import.meta.url), 'utf8'),
};

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
    await db.query("INSERT INTO entities VALUES ('keyword','k',1,'{\"name\":\"Keep\"}')");
    await upgradeBrowserSchema(db, schemaSql);
    assert.deepEqual((await db.query('SELECT payload FROM entities')).rows, [{ payload: { name: 'Keep' } }]);
    assert.deepEqual((await db.query('SELECT * FROM embedding_migration_archive')).rows, []);
  } finally { await db.close(); }
});

test('v2 browser vectors become product embeddings with verbatim payload archives', async () => {
  const db = new PGlite();
  try {
    const before = await legacyDatabase(db);
    await upgradeBrowserSchema(db, schemaSql);
    const expected = migrateEuclideanVector(before);
    assert.deepEqual((await db.query("SELECT payload FROM entities WHERE kind='keyword-vector'")).rows, [{ payload: expected }]);
    assert.equal(Number((await db.query<{ updated_at: number }>("SELECT updated_at FROM entities WHERE kind='keyword-vector'")).rows[0]!.updated_at), 99);
    assert.deepEqual((await db.query('SELECT keyword_id,source FROM embedding_migration_archive')).rows, [{ keyword_id: 'k', source: before }]);
    assert.deepEqual((await db.query("SELECT payload FROM entities WHERE kind='person'")).rows, [{ payload: { name: 'Keep me' } }]);
    const snapshot = (await db.query('SELECT * FROM entities ORDER BY kind,id')).rows;
    await upgradeBrowserSchema(db, schemaSql);
    assert.deepEqual((await db.query('SELECT * FROM entities ORDER BY kind,id')).rows, snapshot);
    assert.deepEqual((await db.query('SELECT keyword_id,source FROM embedding_migration_archive')).rows, [{ keyword_id: 'k', source: before }]);
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
    await db.query('INSERT INTO entities VALUES($1,$2,$3,$4)', ['keyword','k',1,JSON.stringify({id:'k',name:'before'})]);
    const added = await listBrowserGraphPage(db, { since: first.checkpoint! });
    assert.equal(added.items[0]!.keyword!.name, 'before');
    await db.query('UPDATE entities SET payload=$1 WHERE kind=$2 AND id=$3', [JSON.stringify({id:'k',name:'after'}),'keyword','k']);
    const changed = await listBrowserGraphPage(db, { since: added.checkpoint! });
    assert.equal(changed.items[0]!.keyword!.name, 'after');
    await db.query('DELETE FROM entities WHERE kind=$1 AND id=$2', ['keyword','k']);
    const removed = await listBrowserGraphPage(db, { since: changed.checkpoint! });
    assert.equal(removed.items[0]!.keyword, null);
  } finally { await db.close(); }
});
