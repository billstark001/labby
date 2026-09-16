import { readFile } from 'node:fs/promises';

export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** PGlite uses exec for SQL batches; node-postgres query accepts them directly. */
  exec?(sql: string): Promise<unknown>;
}

export async function runSqlFile(client: MigrationClient, file: string): Promise<void> {
  const sql = await readFile(new URL(file, import.meta.url), 'utf8');
  if (client.exec) await client.exec(sql);
  else await client.query(sql);
}
