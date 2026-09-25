import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { runSqlFile } from '../src/store/migrate/runtime.js';
import { resolveCliTarget, safeError } from '../scripts/db-cli.js';

test('CLI target priority, address-only environment and secret redaction', () => {
  assert.deepEqual(
    resolveCliTarget(
      { pglite: 'explicit' },
      { DATABASE_URL: 'postgres://hidden', DB_DRIVER: 'postgres' },
    ),
    { dialect: 'pglite', dataDir: 'explicit' },
  );
  assert.deepEqual(
    resolveCliTarget({}, { DATABASE_URL: 'postgres://test', DATABASE_SSL: 'true' }),
    { dialect: 'postgres', connectionString: 'postgres://test', ssl: true },
  );
  assert.throws(() => resolveCliTarget({ postgres: 'x', pglite: 'y' }, {}), /only one/);
  assert.throws(() => resolveCliTarget({ postgres: '' }, {}), /empty/);
  const target = {
    dialect: 'postgres' as const,
    connectionString: 'postgres://user:secret@host/db',
  };
  assert.ok(
    !safeError(new Error('failed postgres://user:secret@host/db password secret'), target).includes(
      'secret',
    ),
  );
});

test('CLI explicit target diagnoses legacy schema, default command migrates, repeated run is harmless', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'labby-cli-test-'));
  const dataDir = path.join(dir, 'db');
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env };
  const run = promisify(execFile);
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      ['--import', 'tsx', 'scripts/db-migrate.ts', '--pglite', dataDir, ...args],
      { cwd, env },
    );
  try {
    const db = new PGlite({ dataDir, extensions: { vector } });
    await runSqlFile(db, '001.up.sql');
    await db.close();
    const status = JSON.parse((await cli('--action', 'status', '--json')).stdout);
    assert.equal(status.state, 'legacy');
    assert.deepEqual(status.applied, []);
    assert.deepEqual(status.pendingVersions, [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(status.migrated, false);
    assert.match(status.nextCommand, /db:migrate/);
    const migrated = await cli();
    assert.match(migrated.stdout, /Migration committed successfully/);
    assert.match(migrated.stdout, /Running migration 2/);
    const again = JSON.parse((await cli('--json')).stdout);
    assert.equal(again.state, 'current');
    assert.equal(again.migrated, false);
    assert.equal(again.applied.length, 9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
