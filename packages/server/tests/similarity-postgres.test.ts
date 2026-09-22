import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, type Pool } from 'pg';
import { initializePostgresSchema } from '../src/store/initialize.js';
import { LabbyStore } from '../src/store/index.js';
import { EmbeddingService } from '../src/lib/embedding-service.js';
import { testUuid } from './support/database.js';

const exec = promisify(execFile);
test(
  'PostgreSQL similarity transaction pins reads and writes, times out on contention and recovers',
  { timeout: 30000 },
  async (t) => {
    try {
      await exec('initdb', ['--version']);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        t.skip('Local PostgreSQL binaries are not installed');
        return;
      }
      throw error;
    }
    // No environment database URL is read. The server only listens on this temporary socket.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'labby-lock-test-'));
    const data = path.join(directory, 'data');
    let started = false;
    let store: LabbyStore | undefined;
    let observer: Client | undefined;
    try {
      await exec('initdb', [
        '-D',
        data,
        '-A',
        'trust',
        '-U',
        'labby_test',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      await exec('pg_ctl', [
        '-D',
        data,
        '-l',
        path.join(directory, 'postgres.log'),
        '-o',
        "-F -h '' -k " + directory,
        '-w',
        'start',
      ]);
      started = true;
      const url =
        'postgresql://labby_test@localhost/postgres?host=' + encodeURIComponent(directory);
      observer = new Client({ connectionString: url });
      await observer.connect();
      await initializePostgresSchema(observer, true);
      store = new LabbyStore({ dialect: 'postgres', connectionString: url });
      await store.listKeywords();
      // A single client pool makes an accidental second checkout fail deterministically.
      (store as unknown as { pgPool: Pool }).pgPool.options.max = 1;
      const [a, b, c, judgmentId, retryId] = ['a', 'b', 'c', 'test', 'retry'].map(testUuid);
      for (const [id, name] of [[a, 'a'], [b, 'b'], [c, 'c']] as const)
        await store.putKeyword({ id, name });
      const service = new EmbeddingService(store);
      await service.start();
      await store.withSimilarityLock(async () => {
        assert.equal((await store!.listKeywords()).length, 3);
      assert.equal((await store!.listGraph()).items.length, 3);
        await store!.withSimilarityLock(async () => {
          assert.equal((await store!.getRankingHistory()).length, 0);
        });
        const held = await observer!.query(
          "SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.objid=192837466 AND l.granted AND a.state='idle in transaction'",
        );
        assert.equal(held.rows[0].count, 1);
      });
      const judgment = {
        id: judgmentId,
        anchorId: a,
        groups: [[b], [c]],
        confidence: 1,
        createdAt: 1,
      };
      const result = await service.trainRanking(judgment);
      assert.equal(result.accepted, true);
      assert.equal((await store.getRankingHistory()).length, 1);
      const before = await store.getKeyword(a);
      await assert.rejects(
        store.withSimilarityLock(async () => {
          await store!.putKeyword({ id: a, name: 'must roll back' });
          throw new Error('injected failure');
        }),
        /injected failure/,
      );
      assert.deepEqual(await store.getKeyword(a), before);

      await observer.query('BEGIN');
      await observer.query('SELECT pg_advisory_xact_lock(192837466)');
      const blocked = service.recommendRanking({});
      // Ordinary reads remain possible, reproducing the reported symptom.
      assert.equal(
        (await observer.query('SELECT count(*)::int AS count FROM keywords')).rows[0].count,
        3,
      );
      await assert.rejects(
        blocked,
        (error: any) => error.code === 'SIMILARITY_BUSY' && error.status === 503,
      );
      await observer.query('ROLLBACK');
      await service.recommendRanking({});
      await service.trainRanking({ ...judgment, id: retryId });
      await service.shutdown();
      const leaked = await observer.query(
        "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=192837466",
      );
      assert.equal(leaked.rows[0].count, 0);
    } finally {
      await observer?.end();
      await store?.close();
      if (started) await exec('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
