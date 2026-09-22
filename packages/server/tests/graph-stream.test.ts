import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializePostgresSchema } from '../src/store/initialize.js';
import { checkPostgresSchema } from '../src/store/schema-state.js';
import { migratePostgresSchema } from '../src/store/schema.js';
import { listGraphPage } from '../src/store/graph.js';
import { createTestStore } from './support/database.js';

const keyword = (id: string) => ({ id, name: id, modifiedAt: 1 });
const ids = {
  zero: '00000000-0000-4000-8000-000000000010',
  a: '10000000-0000-4000-8000-000000000001',
  b: '20000000-0000-4000-8000-000000000002',
  c: '30000000-0000-4000-8000-000000000003',
};
test('schema checks and migrate never initialize an empty database', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(checkPostgresSchema(db), /db:init/);
    await assert.rejects(migratePostgresSchema(db), /db:init/);
    await db.exec('CREATE TABLE persons(id text PRIMARY KEY)');
    await assert.rejects(checkPostgresSchema(db), /db:migrate/);
    await db.exec('DROP TABLE persons');
    assert.deepEqual(
      (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows,
      [],
    );
    await initializePostgresSchema(db);
    await checkPostgresSchema(db);
    await assert.rejects(initializePostgresSchema(db), /empty public schema/);
  } finally {
    await db.close();
  }
});

test('cursor bootstrap catches edits, inserts behind cursor and deletions during paging', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    for (const id of [ids.a, ids.b, ids.c]) await store.putKeyword(keyword(id));
    const first = await store.listGraph({ limit: 1 });
    assert.deepEqual(
      first.items.map((row) => row.id),
      [ids.a],
    );
    await store.putKeyword({ ...keyword(ids.a), name: 'changed', modifiedAt: 1 });
    await store.putKeyword(keyword(ids.zero));
    await store.deleteKeyword(ids.b);
    const second = await store.listGraph({ cursor: first.nextCursor!, limit: 1 });
    assert.deepEqual(
      second.items.map((row) => row.id),
      [ids.c],
    );
    assert.ok(second.checkpoint);
    const changes = await store.listGraph({ since: second.checkpoint! });
    assert.deepEqual(changes.items.map((row) => row.id).sort(), [ids.zero, ids.a, ids.b].sort());
    assert.equal(changes.items.find((row) => row.id === ids.b)!.keyword, null);
    assert.equal(changes.items.find((row) => row.id === ids.a)!.keyword!.name, 'changed');
    assert.equal((await store.listGraph({ since: changes.checkpoint! })).items.length, 0);
  } finally {
    await store.close();
  }
});

test('delta pages are bounded and changes beyond their high-water mark are read next', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    const initial = await store.listGraph();
    for (const id of [ids.a, ids.b, ids.c]) await store.putKeyword(keyword(id));
    const first = await store.listGraph({ since: initial.checkpoint!, limit: 1 });
    assert.equal(first.items[0]!.id, ids.a);
    await store.putKeyword({ ...keyword(ids.b), name: 'late' });
    const second = await store.listGraph({ cursor: first.nextCursor!, limit: 1 });
    assert.equal(second.items[0]!.id, ids.c);
    const nextBatch = await store.listGraph({ since: second.checkpoint! });
    assert.deepEqual(
      nextBatch.items.map((row) => row.id),
      [ids.b],
    );
    assert.equal(nextBatch.items[0]!.keyword!.name, 'late');
    await assert.rejects(store.listGraph({ cursor: 'broken' }), /Invalid graph/);
    await assert.rejects(store.listGraph({ limit: 251 }), /Invalid graph/);
    const foreign = JSON.stringify({ epoch: 'other-database', revision: '0' });
    assert.equal((await store.listGraph({ since: foreign })).reset, true);
  } finally {
    await store.close();
  }
});

test('rolled-back updates do not advance the graph clock or publish changes', async () => {
  const db = new PGlite();
  try {
    await initializePostgresSchema(db);
    const before = await listGraphPage(db);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO keywords(id,payload) VALUES($1,$2)', [
          ids.a,
          JSON.stringify(keyword(ids.a)),
        ]);
        throw new Error('rollback');
      }),
    );
    const after = await listGraphPage(db, { since: before.checkpoint! });
    assert.deepEqual(after.items, []);
    assert.equal(after.checkpoint, before.checkpoint);
  } finally {
    await db.close();
  }
});

test('snapshot pages load enabled keywords before disabled keywords', async () => {
  const store = await createTestStore({ dialect: 'pglite', dataDir: 'memory://' });
  try {
    await store.putKeyword({ ...keyword(ids.a), disabled: true });
    await store.putKeyword(keyword(ids.b));
    const first = await store.listGraph({ limit: 1 });
    assert.equal(first.items[0]?.id, ids.b);
    const second = await store.listGraph({ cursor: first.nextCursor!, limit: 1 });
    assert.equal(second.items[0]?.id, ids.a);
    assert.equal(second.items[0]?.keyword?.disabled, true);
  } finally { await store.close(); }
});

test('current-schema init and historical migration produce the same table columns', async () => {
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { runSqlFile } = await import('../src/store/migrate/runtime.js');
  const fresh = new PGlite();
  const upgraded = new PGlite({ extensions: { vector } });
  try {
    await initializePostgresSchema(fresh);
    await runSqlFile(upgraded, '001.up.sql');
    await migratePostgresSchema(upgraded);
    const columns =
      "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position";
    const normalize = (rows: unknown[]) =>
      [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(
      normalize((await fresh.query(columns)).rows),
      normalize((await upgraded.query(columns)).rows),
    );
    const triggers =
      "SELECT event_object_table,trigger_name,event_manipulation FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY 1,2,3";
    assert.deepEqual((await fresh.query(triggers)).rows, (await upgraded.query(triggers)).rows);
  } finally {
    await fresh.close();
    await upgraded.close();
  }
});
