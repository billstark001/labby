/** Current shared PostgreSQL/PGlite layout. Historical migrations remain with their original runtimes. */
export const SCHEMA_NAMES = [
  'baseline',
  'product-embedding-and-ranking-history',
  'graph-change-feed',
  'jsonb-documents',
  'uuid-timestamptz-person-tags',
  'constraint-tag-targets',
  'localized-person-tags-and-constraint-state',
  'unavailability-selectors-and-closures',
  'scheduler-dispatch-deduplication',
  'unified-pair-constraint-groups',
  'shared-app-metadata',
] as const;
export const SCHEMA_VERSION = SCHEMA_NAMES.length;
