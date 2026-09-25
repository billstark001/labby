import type { ListQuery } from '@labby/core';

export type PagedTable = 'persons' | 'person_tags' | 'keywords';

export function buildEntityPageQueries(
  table: PagedTable,
  query: ListQuery,
  collation: '"C"' | '"en-x-icu"' | '"zh-x-icu"' | '"ja-x-icu"',
): { pageSql: string; countSql: string; offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(query.offset));
  const limit = Math.max(1, Math.min(500, Math.floor(query.limit)));
  const direction = query.sortDirection === 'desc' ? 'DESC' : 'ASC';
  const sort = query.sortBy ?? 'modifiedAt';
  const language = query.locale === 'zh-CN' ? 'zh' : query.locale === 'ja-JP' ? 'ja' : 'en';
  const localizedName = (alias: string) =>
    `lower(coalesce(nullif(btrim(${alias}.payload->'names'->>'${language}'), ''), ` +
    `nullif(btrim(${alias}.payload->'names'->>'en'), ''), ` +
    `btrim(coalesce(${alias}.payload->>'name', '')))) COLLATE ${collation}`;
  const nameExpr = localizedName('t');
  const notesExpr = `lower(btrim(coalesce(t.payload->>'notes', ''))) COLLATE "C"`;
  const modifiedExpr = `coalesce((t.payload->>'modifiedAt')::bigint, 0)`;
  let primary = `${modifiedExpr} ${query.sortDirection === 'asc' ? 'ASC' : 'DESC'}`;
  let joins = '';
  if (sort === 'name') primary = `${nameExpr} ${direction}`;
  if (sort === 'notes') primary = `${notesExpr} ${direction}`;
  if (sort === 'disabled' && table !== 'person_tags')
    primary = `coalesce((t.payload->>'disabled')::boolean, false) ${direction}`;
  if (sort === 'tags' && table === 'persons') {
    joins = `LEFT JOIN LATERAL (
      SELECT string_agg(${localizedName('tag')}, '|' ORDER BY ${localizedName('tag')}, tag.id) AS names
      FROM jsonb_array_elements_text(coalesce(t.payload->'tagIds', '[]'::jsonb)) AS member(tag_id)
      JOIN person_tags tag ON tag.id::text = member.tag_id
    ) tag_sort ON true`;
    primary = `tag_sort.names IS NULL ASC, tag_sort.names ${direction}`;
  }
  if (sort === 'keywords' && table === 'persons') {
    joins = `LEFT JOIN LATERAL (
      SELECT string_agg(${localizedName('keyword')}, '|' ORDER BY ${localizedName('keyword')}, keyword.id) AS names
      FROM jsonb_array_elements_text(coalesce(t.payload->'keywordIds', '[]'::jsonb)) AS member(keyword_id)
      JOIN keywords keyword ON keyword.id::text = member.keyword_id
    ) keyword_sort ON true`;
    primary = `keyword_sort.names IS NULL ASC, keyword_sort.names ${direction}`;
  }
  return {
    pageSql: `SELECT t.payload FROM ${table} t ${joins} ORDER BY ${primary}, ${modifiedExpr} DESC, ` +
      `${nameExpr} ASC, ${notesExpr} ASC, t.id ASC LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT count(*)::int AS total FROM ${table}`,
    offset,
    limit,
  };
}
