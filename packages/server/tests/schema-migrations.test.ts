import type { MigrationClient } from '../src/store/migrate/runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { migrateEuclideanVector } from '../src/store/migrate/002-projection.js';
import { migratePostgresSchema } from '../src/store/schema.js';
import { runSqlFile } from '../src/store/migrate/runtime.js';
import { up as productEmbeddingUp } from '../src/store/migrate/002.up.js';

async function memoryDatabase() {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  return db;
}

async function legacyDatabase(db: PGlite, dimensions = 64) {
  await db.exec(`
    CREATE EXTENSION vector;
    CREATE TABLE persons (id text PRIMARY KEY, payload jsonb NOT NULL);
    CREATE TABLE keywords (id text PRIMARY KEY, payload jsonb NOT NULL);
    CREATE TABLE keyword_vectors (
      keyword_id text PRIMARY KEY REFERENCES keywords(id),
      x double precision NOT NULL, y double precision NOT NULL,
      vector64 vector(${dimensions}) NOT NULL, projection2d vector(2) NOT NULL,
      updated_at bigint NOT NULL, payload jsonb NOT NULL
    );
    INSERT INTO persons VALUES ('person', '{"name":"Preserve me"}');
    INSERT INTO keywords VALUES ('physics', '{"name":"Physics"}');
  `);
  const coordinates = Array.from({ length: dimensions }, (_, i) => (i - 20) / 64);
  await db.query('INSERT INTO keyword_vectors VALUES ($1,$2,$3,$4::vector,$5::vector,$6,$7::jsonb)',
    ['physics', 12, -7, JSON.stringify(coordinates), '[12,-7]', 123456789, JSON.stringify({ legacyMetadata: 'preserve verbatim', vector64: coordinates })]);
  return coordinates;
}

async function version3Database(db: PGlite) {
  await runSqlFile(db, '001.up.sql');
  await productEmbeddingUp(db);
  await runSqlFile(db, '003.up.sql');
}

test('fresh migration builds the current schema and remains idempotent', async () => {
  const db = await memoryDatabase();
  try {
    await initializePostgresSchema(db);
    const history = await db.query('SELECT * FROM schema_migrations ORDER BY version');
    assert.equal(history.rows.length, SERVER_SCHEMA_VERSION);
    const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='keyword_vectors'");
    assert.ok(columns.rows.some(row => row.column_name === 'embedding'));
    assert.ok(columns.rows.some(row => row.column_name === 'geometry'));
    assert.ok(!columns.rows.some(row => ['vector64', 'projection2d'].includes(row.column_name)));
    const judgmentId = '10000000-0000-4000-8000-000000000001';
    await db.query('INSERT INTO ranking_judgments VALUES ($1,\'{"keep":true}\')', [judgmentId]);
    await migratePostgresSchema(db);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, history.rows);
    assert.deepEqual((await db.query('SELECT * FROM ranking_judgments')).rows, [{ id: judgmentId, payload: { keep: true } }]);
    // The caller retains ownership of its connection after migration.
    assert.deepEqual((await db.query('SELECT 1 AS alive')).rows, [{ alive: 1 }]);
  } finally { await db.close(); }
});

test('legacy vectors are converted deterministically and the entire source row is archived', async () => {
  const db = await memoryDatabase();
  try {
    const coordinates = await legacyDatabase(db);
    const before = (await db.query<{ source: unknown }>('SELECT to_jsonb(keyword_vectors) AS source FROM keyword_vectors')).rows[0]!.source;
    await migratePostgresSchema(db);
    const migratedKeywordId = String((await db.query('SELECT id FROM keywords')).rows[0]!.id);
    const expected = migrateEuclideanVector({ keywordId: migratedKeywordId, vector64: coordinates, updatedAt: 123456789 });
    const row = (await db.query('SELECT * FROM keyword_vectors')).rows[0]!;
    assert.deepEqual(row.embedding, expected.embedding);
    assert.deepEqual(row.geometry, expected.geometry);
    assert.deepEqual(row.payload, expected);
    assert.equal(row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(String(row.updated_at)).getTime(), expected.updatedAt);
    assert.equal(row.x, expected.x);
    assert.equal(row.y, expected.y);
    assert.deepEqual((await db.query('SELECT source FROM embedding_migration_archive')).rows, [{ source: before }]);
    assert.deepEqual((await db.query('SELECT payload FROM persons')).rows, [{ payload: { name: 'Preserve me' } }]);
    assert.deepEqual((await db.query('SELECT payload FROM keywords')).rows, [{ payload: { name: 'Physics' } }]);
    await migratePostgresSchema(db);
    assert.deepEqual((await db.query('SELECT source FROM embedding_migration_archive')).rows, [{ source: before }]);
  } finally { await db.close(); }
});

test('malformed legacy vector rolls back archive, DDL, migration history and data together', async () => {
  const db = await memoryDatabase();
  try {
    await legacyDatabase(db, 3);
    const before = (await db.query('SELECT to_jsonb(keyword_vectors) AS source FROM keyword_vectors')).rows;
    await assert.rejects(migratePostgresSchema(db), /malformed Euclidean keyword vector/);
    assert.deepEqual((await db.query('SELECT to_jsonb(keyword_vectors) AS source FROM keyword_vectors')).rows, before);
    assert.deepEqual((await db.query("SELECT to_regclass('schema_migrations') AS history, to_regclass('embedding_migration_archive') AS archive")).rows, [{ history: null, archive: null }]);
    assert.deepEqual((await db.query('SELECT 1 AS alive')).rows, [{ alive: 1 }]);
  } finally { await db.close(); }
});

test('newer and inconsistent migration histories are rejected without mutation', async () => {
  const db = await memoryDatabase();
  try {
    await initializePostgresSchema(db);
    await db.query("INSERT INTO schema_migrations(version,name) VALUES ($1,'future-schema')", [SERVER_SCHEMA_VERSION + 1]);
    const before = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    await assert.rejects(migratePostgresSchema(db), /newer|Unknown|inconsistent/);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, before);
    await db.query('DELETE FROM schema_migrations WHERE version=$1', [SERVER_SCHEMA_VERSION + 1]);
    await db.query("UPDATE schema_migrations SET name='incorrect' WHERE version=1");
    await assert.rejects(migratePostgresSchema(db), /Unknown|inconsistent/);
  } finally { await db.close(); }
});

test('an unrecognized unversioned database is not adopted or changed', async () => {
  const db = await memoryDatabase();
  try {
    await db.exec("CREATE TABLE persons (id text PRIMARY KEY); INSERT INTO persons VALUES ('existing')");
    await assert.rejects(migratePostgresSchema(db), /Unrecognized unversioned database schema/);
    assert.deepEqual((await db.query('SELECT * FROM persons')).rows, [{ id: 'existing' }]);
    assert.deepEqual((await db.query("SELECT to_regclass('schema_migrations') AS history")).rows, [{ history: null }]);
  } finally { await db.close(); }
});

test('Postgres mode locks on the supplied connection inside the transaction', async () => {
  const statements: string[] = [];
  const client: MigrationClient = {
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT version')) return { rows: [
        { version: 1, name: 'baseline' },
        { version: 2, name: 'product-embedding-and-ranking-history' },
        { version: 3, name: 'graph-change-feed' },
      ] };
      return { rows: [] };
    },
  };
  await migratePostgresSchema(client, true);
  assert.equal(statements[0], 'BEGIN');
  assert.match(statements[1]!, /pg_advisory_xact_lock/);
  assert.ok(statements.findIndex(sql => sql.startsWith('LOCK TABLE')) < statements.findIndex(sql => sql.startsWith('SELECT version')));
  assert.equal(statements.at(-1), 'COMMIT');
});

import { SERVER_SCHEMA_VERSION } from '../src/store/schema-state.js';
import { initializePostgresSchema } from '../src/store/initialize.js';

test('v4 converts legacy TEXT documents and defaults, preserving values and resetting cursors', async () => {
  const db = await memoryDatabase();
  try {
    await version3Database(db);
    await db.exec("ALTER TABLE keywords ALTER COLUMN payload TYPE text USING payload::text");
    await db.exec("ALTER TABLE persons ALTER COLUMN keyword_ids DROP DEFAULT; ALTER TABLE persons ALTER COLUMN keyword_ids TYPE text USING keyword_ids::text; ALTER TABLE persons ALTER COLUMN keyword_ids SET DEFAULT '[]'");
    await db.query('INSERT INTO keywords(id,payload) VALUES($1,$2)', ['physics', JSON.stringify({id:'physics', names:{zh:'物理'}, nested:{preserve:[1,null,true]}})]);
    const before = (await db.query('SELECT payload::jsonb AS payload FROM keywords')).rows;
    const epoch = (await db.query('SELECT epoch FROM graph_clock')).rows[0]!.epoch;
    await db.transaction(tx => runSqlFile(tx, '004.up.sql'));
    assert.deepEqual((await db.query('SELECT payload FROM keywords')).rows, before);
    assert.notEqual((await db.query('SELECT epoch FROM graph_clock')).rows[0]!.epoch, epoch);
    await db.query("INSERT INTO persons(id,payload) VALUES('p','{}')");
    assert.deepEqual((await db.query("SELECT keyword_ids FROM persons WHERE id='p'")).rows, [{keyword_ids:[]}]);
    const { listGraphPage } = await import('../src/store/graph.js');
    assert.equal((await listGraphPage(db)).items[0]!.keyword!.id, 'physics');
  } finally { await db.close(); }
});

test('v4 invalid JSON rolls back earlier column conversions and migration version', async () => {
  const db = await memoryDatabase();
  try {
    await version3Database(db);
    await db.exec("ALTER TABLE configs ALTER COLUMN payload TYPE text USING payload::text; ALTER TABLE keywords ALTER COLUMN payload TYPE text USING payload::text");
    await db.query("INSERT INTO keywords(id,payload) VALUES('broken','invalid JSON')");
    const before = (await db.query('SELECT * FROM graph_clock')).rows;
    await assert.rejects(db.transaction(tx => runSqlFile(tx, '004.up.sql')), /json/i);
    assert.deepEqual((await db.query("SELECT data_type FROM information_schema.columns WHERE table_name='configs' AND column_name='payload'")).rows,[{data_type:'text'}]);
    assert.deepEqual((await db.query('SELECT * FROM graph_clock')).rows,before);
  } finally { await db.close(); }
});
