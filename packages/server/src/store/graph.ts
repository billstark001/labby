import {
  planGraphPage,
  finishGraphPage,
  type GraphQuery,
  type GraphPage,
  type GraphRow,
} from '@labby/core';
import type { MigrationClient } from './migrate/runtime.js';

export async function listGraphPage(
  client: MigrationClient,
  query: GraphQuery = {},
): Promise<GraphPage> {
  const clockRow = (
    await client.query('SELECT epoch, revision::text FROM graph_clock WHERE singleton')
  ).rows[0]!;
  const plan = planGraphPage(query, {
    epoch: String(clockRow.epoch),
    revision: String(clockRow.revision),
  });
  if (!plan) return finishGraphPage(null, []);
  const result =
    plan.mode === 'snapshot'
      ? await client.query(
          'SELECT k.id, k.payload AS keyword, v.payload AS vector FROM keywords k LEFT JOIN keyword_vectors v ON v.keyword_id=k.id WHERE k.id COLLATE "C" > $1 COLLATE "C" ORDER BY k.id COLLATE "C" LIMIT $2',
          [plan.after, plan.limit + 1],
        )
      : await client.query(
          'SELECT c.keyword_id AS id, c.revision::text AS revision, k.payload AS keyword, v.payload AS vector FROM graph_changes c LEFT JOIN keywords k ON k.id=c.keyword_id LEFT JOIN keyword_vectors v ON v.keyword_id=c.keyword_id WHERE c.revision > $1::bigint AND c.revision <= $2::bigint ORDER BY c.revision LIMIT $3',
          [plan.after, plan.revision, plan.limit + 1],
        );
  return finishGraphPage(plan, result.rows as unknown as GraphRow[]);
}
