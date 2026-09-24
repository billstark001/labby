import type { StoreConnectionConfig } from '../src/store/index.js';
import { initializePostgresSchema } from '../src/store/initialize.js';
import { parseDatabaseArgs, safeError, withDatabase } from './db-cli.js';
import { inspectSchema } from '../src/store/schema-status.js';

let target: StoreConnectionConfig | undefined;
try {
  const args = parseDatabaseArgs('init');
  target = args.target;
  if (args.values.help) {
    console.log(
      'Usage: pnpm --filter @labby/server db:init [--postgres URL | --pglite DIR] [--json]',
    );
    console.log(
      'Creates the complete current schema in an empty database. The package command injects the env-lane server target.',
    );
  } else {
    if (args.values.action !== 'init')
      throw new Error(
        'db:init only supports initialization. Use db:migrate --action status to inspect.',
      );
    await withDatabase(target, async (client, postgres) => {
      await initializePostgresSchema(client, postgres);
      const status = await inspectSchema(client);
      if (args.values.json) console.log(JSON.stringify({ ...status, action: 'init' }, null, 2));
      else console.log('Current schema initialized successfully. The server can now start.');
    });
  }
} catch (error) {
  console.error('Database initialization failed: ' + safeError(error, target));
  process.exitCode = 1;
}
