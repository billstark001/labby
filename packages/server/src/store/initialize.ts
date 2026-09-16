import { readFile } from 'node:fs/promises';
import type { MigrationClient } from './migrate/runtime.js';

/** Manual CLI/test fixture only. Creates the complete current schema without running migrations. */
export async function initializePostgresSchema(
  client: MigrationClient,
  postgres = false,
): Promise<void> {
  await client.query('BEGIN');
  try {
    if (postgres) await client.query('SELECT pg_advisory_xact_lock(192837465)');
    const existing = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' LIMIT 1",
    );
    if (existing.rows.length)
      throw new Error(
        'db:init requires an empty public schema; use db:migrate for an existing database.',
      );
    const sql = await readFile(new URL('./current-schema.sql', import.meta.url), 'utf8');
    if (client.exec) await client.exec(sql);
    else await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
