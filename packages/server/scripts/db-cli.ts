import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { Client } from 'pg';
import type { MigrationClient } from '../src/store/migrate/runtime.js';
import type { StoreConnectionConfig } from '../src/store/index.js';
import { resolveStoreConnectionConfig } from '../src/lib/runtime-config.js';

export function resolveCliTarget(
  options: { postgres?: string; pglite?: string },
  env: NodeJS.ProcessEnv,
): StoreConnectionConfig {
  if (options.postgres !== undefined && options.pglite !== undefined)
    throw new Error('Choose only one of --postgres and --pglite.');
  if (options.postgres !== undefined) {
    if (!options.postgres.trim()) throw new Error('--postgres must not be empty.');
    return {
      dialect: 'postgres',
      connectionString: options.postgres,
      ssl: env.DATABASE_SSL === '1' || env.DATABASE_SSL === 'true',
    };
  }
  if (options.pglite !== undefined) {
    if (!options.pglite.trim()) throw new Error('--pglite must not be empty.');
    return { dialect: 'pglite', dataDir: options.pglite };
  }
  // DATABASE_URL alone is sufficient for a maintenance command.
  const resolvedEnv =
    env.DATABASE_URL?.trim() && !env.DB_DRIVER?.trim() ? { ...env, DB_DRIVER: 'postgres' } : env;
  return resolveStoreConnectionConfig(resolvedEnv);
}

export function parseDatabaseArgs(defaultAction: 'init' | 'up') {
  const { values } = parseArgs({
    options: {
      postgres: { type: 'string' },
      pglite: { type: 'string' },
      action: { type: 'string', default: defaultAction },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { values, target: { dialect: 'pglite' as const, dataDir: '' } };
  return { values, target: resolveCliTarget(values, process.env) };
}

export async function withDatabase<T>(
  target: StoreConnectionConfig,
  work: (client: MigrationClient, postgres: boolean) => Promise<T>,
): Promise<T> {
  const pg =
    target.dialect === 'postgres'
      ? new Client({
          connectionString: target.connectionString,
          ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
          connectionTimeoutMillis: 15000,
        })
      : undefined;
  const local =
    target.dialect === 'pglite'
      ? new PGlite({ dataDir: target.dataDir, extensions: { vector } })
      : undefined;
  try {
    await pg?.connect();
    const client: MigrationClient = pg ?? {
      query: (sql, params) => local!.query(sql, params),
      exec: (sql) => local!.exec(sql),
    };
    // Fail rather than waiting indefinitely for a live application's locks.
    if (pg) await client.query("SET lock_timeout = '15s'");
    return await work(client, Boolean(pg));
  } finally {
    await pg?.end();
    await local?.close();
  }
}

/** Connection URLs/passwords are never included in diagnostic output. */
export function safeError(error: unknown, target?: StoreConnectionConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  if (target?.dialect === 'postgres') {
    message = message.replaceAll(target.connectionString, '[database connection]');
    try {
      const url = new URL(target.connectionString);
      for (const value of [url.password, decodeURIComponent(url.password)]) {
        if (value) message = message.replaceAll(value, '[redacted]');
      }
    } catch {
      /* The driver will report malformed connection strings. */
    }
  }
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database connection]');
}
