import { migrateEuclideanVector } from './002-projection.js';
import { runSqlFile, type MigrationClient } from './runtime.js';

/**
 * The runner owns the transaction, including this version's history entry.
 * JS preserves the original signed 32-bit projection exactly (Math.imul).
 */
export async function up(client: MigrationClient): Promise<void> {
  await runSqlFile(client, '002.prepare.sql');
  const { rows } = await client.query(
    'SELECT keyword_id, vector64::text AS vector64, updated_at FROM keyword_vectors',
  );
  for (const row of rows) {
    const value = migrateEuclideanVector({
      keywordId: String(row.keyword_id),
      vector64: JSON.parse(String(row.vector64)),
      updatedAt: Number(row.updated_at),
    });
    await client.query(
      'UPDATE keyword_vectors SET embedding=$1::jsonb, geometry=$2::jsonb, x=$3, y=$4, payload=$5::jsonb WHERE keyword_id=$6',
      [
        JSON.stringify(value.embedding),
        JSON.stringify(value.geometry),
        value.x,
        value.y,
        JSON.stringify(value),
        value.keywordId,
      ],
    );
  }
  await runSqlFile(client, '002.finish.sql');
}
