import { parseDatabaseArgs, withDatabase, safeError } from './db-cli.js';
import type { StoreConnectionConfig } from '../src/store/index.js';

let target: StoreConnectionConfig | undefined;
try {
  const args = parseDatabaseArgs('status');
  target = args.target;
  const { values } = args;
  if (values.help) {
    console.log(
      'Usage: pnpm --filter @labby/server db:similarity-locks [--action status|release-legacy] [--postgres URL]',
    );
    console.log('Default is read-only. Stop all old server instances before release-legacy.');
  } else {
    if (target.dialect !== 'postgres')
      throw new Error('This diagnostic applies to PostgreSQL only.');
    if (!['status', 'release-legacy'].includes(values.action!))
      throw new Error('Use status or release-legacy.');
    await withDatabase(target, async (client) => {
      if (values.action === 'release-legacy') {
        // An explicit transaction pins this maintenance connection to its assigned backend.
        // Only that backend's session locks can be released; never terminate another session.
        await client.query('BEGIN');
        try {
          let released = 0;
          for (let attempt = 0; attempt < 1000; attempt++) {
            const own = (
              await client.query(
                "SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=0 AND objid=192837466 AND objsubid=1 AND granted",
              )
            ).rows;
            if (!own.length) break;
            const unlocked = (
              await client.query('SELECT pg_advisory_unlock(192837466) AS unlocked')
            ).rows[0]?.unlocked;
            if (!unlocked) break; // Transaction-level locks must be left to their owning transaction.
            released++;
          }
          await client.query('COMMIT');
          console.log(
            'Released legacy session-lock acquisitions on the assigned backend: ' + released,
          );
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      const rows = (
        await client.query(`SELECT l.pid,l.granted,a.state,a.wait_event_type,a.wait_event,
        extract(epoch from now()-a.query_start)::int AS query_age_seconds,
        pg_blocking_pids(l.pid) AS blocked_by,
        l.pid=pg_backend_pid() AS owned_by_diagnostic_backend
        FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.classid=0 AND l.objid=192837466 AND l.objsubid=1`)
      ).rows;
      console.log(JSON.stringify({ locks: rows }, null, 2));
      if (rows.length) {
        console.log(
          'Locks remain. Stop old server instances before cleanup. Session locks behind transaction pooling can outlive the application connection.',
        );
        console.log(
          'Run db:similarity-locks --action release-legacy to release only legacy locks on the backend assigned to this command. If another backend still holds the lock, a database administrator must inspect it.',
        );
      } else console.log('No similarity advisory locks remain. Start the updated server.');
    });
  }
} catch (error) {
  console.error(safeError(error, target));
  process.exitCode = 1;
}
