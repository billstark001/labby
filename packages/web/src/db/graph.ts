import {
  planGraphPage,
  finishGraphPage,
  type GraphPage,
  type GraphQuery,
  type GraphRow,
} from '@labby/core';
import type { PGliteWorker } from '@electric-sql/pglite/worker';

export async function listBrowserGraphPage(
  client: Pick<PGliteWorker, 'query'>,
  query: GraphQuery = {},
): Promise<GraphPage> {
  const clock = (
    await client.query<{ epoch: string; revision: string }>(
      'SELECT epoch,revision::text FROM graph_clock WHERE singleton',
    )
  ).rows[0]!;
  const plan = planGraphPage(query, clock);
  if (!plan) return finishGraphPage(null, []);
  const result =
    plan.mode === 'snapshot'
      ? await client.query<GraphRow>(
          'SELECT k.id,k.payload AS keyword,v.payload AS vector FROM entities k LEFT JOIN entities v ON v.kind=$1 AND v.id=k.id WHERE k.kind=$2 AND k.id COLLATE "C" > $3 COLLATE "C" ORDER BY k.id COLLATE "C" LIMIT $4',
          ['keyword-vector', 'keyword', plan.after, plan.limit + 1],
        )
      : await client.query<GraphRow>(
          'SELECT c.keyword_id AS id,c.revision::text AS revision,k.payload AS keyword,v.payload AS vector FROM graph_changes c LEFT JOIN entities k ON k.kind=$1 AND k.id=c.keyword_id LEFT JOIN entities v ON v.kind=$2 AND v.id=c.keyword_id WHERE c.revision > $3::bigint AND c.revision <= $4::bigint ORDER BY c.revision LIMIT $5',
          ['keyword', 'keyword-vector', plan.after, plan.revision, plan.limit + 1],
        );
  return finishGraphPage(plan, result.rows);
}
