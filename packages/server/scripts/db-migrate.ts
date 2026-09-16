import type { StoreConnectionConfig } from '../src/store/index.js';
import { parseDatabaseArgs, safeError, withDatabase } from './db-cli.js';
import { inspectSchema, type SchemaStatus } from '../src/store/schema-status.js';
import { migratePostgresSchema } from '../src/store/schema.js';

function describe(status: SchemaStatus, action: string) {
  console.log(
    'Database state: ' + status.state + ' (supported version ' + status.supportedVersion + ')',
  );
  console.log(status.message);
  if (status.applied.length)
    console.log('Recorded versions: ' + status.applied.map((row) => row.version).join(', '));
  if (status.pendingVersions.length && status.state !== 'empty')
    console.log('Pending versions: ' + status.pendingVersions.join(', '));
  if (action === 'status') console.log('Status only: no migration was executed.');
  if (status.nextCommand && (action === 'status' || status.state === 'empty'))
    console.log('Next: ' + status.nextCommand + ' (reuse the same target options, if supplied).');
}

let target: StoreConnectionConfig | undefined;
try {
  const args = parseDatabaseArgs('up');
  target = args.target;
  const { values } = args;
  if (values.help) {
    console.log(
      'Usage: pnpm --filter @labby/server db:migrate [--action up|status|archive] [--postgres URL | --pglite DIR] [--env-file FILE] [--json]',
    );
    console.log(
      'Default action: up. Connection priority: explicit option, environment, packages/server/.env, runtime PGlite default.',
    );
  } else {
    if (!['up', 'status', 'archive'].includes(values.action!))
      throw new Error('Invalid action. Use up, status or archive.');
    await withDatabase(target, async (client, postgres) => {
      if (values.action === 'archive') {
        const exists = (
          await client.query("SELECT to_regclass('public.embedding_migration_archive') AS name")
        ).rows[0]?.name;
        if (!exists) throw new Error('No migration archive exists yet. Run db:migrate first.');
        console.log(
          JSON.stringify(
            (
              await client.query(
                'SELECT keyword_id,source,archived_at FROM embedding_migration_archive ORDER BY keyword_id',
              )
            ).rows,
            null,
            2,
          ),
        );
        return;
      }
      const before = await inspectSchema(client);
      if (values.action === 'status') {
        if (values.json)
          console.log(JSON.stringify({ ...before, action: 'status', migrated: false }, null, 2));
        else describe(before, 'status');
        return;
      }
      if (!values.json) describe(before, 'up');
      if (before.state === 'empty' || before.state === 'inconsistent') {
        throw new Error(
          before.message + (before.nextCommand ? ' Next: ' + before.nextCommand : ''),
        );
      }
      if (before.state !== 'current') {
        await migratePostgresSchema(client, postgres, (message) => {
          if (!values.json) console.log(message);
        });
      }
      const after = await inspectSchema(client);
      if (after.state !== 'current')
        throw new Error(
          'Migration finished but the schema is not current. Inspect database status.',
        );
      const migrated = before.state !== 'current';
      if (values.json) console.log(JSON.stringify({ ...after, action: 'up', migrated }, null, 2));
      else
        console.log(
          migrated
            ? 'Migration committed successfully. Database is current; the server can now start.'
            : 'Database is already current. No changes were made.',
        );
    });
  }
} catch (error) {
  console.error('Database migration failed: ' + safeError(error, target));
  process.exitCode = 1;
}
