# Database migrations

## Safety and execution

Tests use isolated PGlite fixtures and do not connect to production. Maintenance commands support
explicit connection options, process environment and dotenv. CLI defaults load packages/server/.env;
--env-file selects a different file. Existing environment values take precedence over dotenv.

Connection priority is --postgres/--pglite, then configured environment, then the runtime's local
PGlite default. DATABASE_URL alone selects PostgreSQL for the CLI; DB_DRIVER, DATABASE_SSL and
PGLITE_DATA_DIR are also supported. Explicit options override environment connection selection.
Diagnostics never print the connection URL or password.

The server never initializes or migrates application schema during startup. It only checks the
schema ledger and refuses to start when initialization or migration is needed.
Run the following commands explicitly (build core first):

```sh
pnpm --filter @labby/core build
# Empty database only: create current schema directly, without replaying migrations.
pnpm --filter @labby/server db:init --pglite /absolute/path/to/test-db
# Existing database: inspect, then apply pending migrations.
pnpm --filter @labby/server db:migrate --pglite /absolute/path/to/test-db --action status
pnpm --filter @labby/server db:migrate --pglite /absolute/path/to/test-db --action up
```

For PostgreSQL use `--postgres <connection-url>` instead of `--pglite`.
db:migrate now defaults to up and actually applies pending migrations. Use --action status for
read-only inspection. Status distinguishes empty, legacy, pending, current and inconsistent schemas,
and includes a next command. Empty applied history alone never implies an empty database.
--json provides structured output including state, pendingVersions, message, nextCommand and migrated.
Status does not apply schema migrations, although opening a new PGlite directory initializes its database files.
Production deployment should first take an external database backup and review this migration.
Production execution must be explicitly authorized; ordinary server startup remains read-only for schema.

## Server version history

1. Baseline: original relational schema and 64D pgvector columns. An existing unversioned database
   is adopted only if its baseline discriminator columns exist.
2. Product embedding and accepted ranking history:
   - Archive the entire original keyword_vectors row as JSONB, keyed by keyword ID.
   - Apply a deterministic signed projection into H8 × R8 spatial coordinates and derive display x/y.
   - Store embedding and geometry as JSONB with a dimension-shape constraint.
   - Remove vector64 and projection2d columns; add ranking_judgments.
3. Graph change feed: transactionally ordered revision clock, per-keyword latest changes and deletion tombstones.
4. JSONB documents: convert legacy TEXT JSON columns and their defaults to JSONB, matching fresh
   initialization. Invalid JSON rolls back the entire migration. Refresh the graph epoch so clients
   discard pre-migration cursors and reload their cached records.

Conversion is approximate: it cannot preserve all old Euclidean distances or reconstruct
judgments that the old application never saved. The original rows remain in
embedding_migration_archive, including payload metadata, for recovery or a different conversion.
Runtime code does not accept the old vector format; its type exists only inside one-way migration code.

schema_migrations records each version, name, and application time. All pending migrations run
in one transaction on one dedicated connection, with PostgreSQL transaction advisory locking.
An error rolls back data, DDL, and version records. Unknown/newer/inconsistent histories fail closed.

## Browser

Browser-local PGlite is explicitly allowed to initialize and migrate automatically. Startup
mounts notification UI before opening the database. Actual initialization, schema upgrade or
legacy import displays progress and completion; failures remain visible with a retry action.

Empty browser databases use current-schema.sql directly. Existing databases migrate to version 4:
version 3 archives and converts old keyword vectors, while version 4 installs the graph revision
clock and change-feed triggers. Each upgrade transaction includes its schema version updates.
ranking-judgment entities store accepted lists.
The earlier IndexedDB import is a one-time migration; source vectors are archived and the
source IndexedDB database is not deleted. No old runtime aliases are retained.

## Backups and recovery

Server backup format is version 2 and contains rankingJudgments and embeddingMigrationArchive.
Old backup format 1 is not accepted by the new restore API. To use such a backup, restore with
the old application into an isolated database first, then run the migration.

Browser DatabaseDump includes rankingHistory, with migration archives kept outside the core
business backup contract. Browser restore leaves existing migration archives intact. Both server and
browser restores are transactional; invalid data rolls back the restore. Schema migration
version records belong to the destination application and are not overwritten by a data restore.

There is no destructive automatic down migration. To return to the old application use an
external pre-upgrade backup; the archive allows manual recovery of old keyword-vector rows.
Other business entities are not transformed by the embedding migration.


## Migration files and archive inspection

Server migrations live in packages/server/src/store/migrate:
- 001.up.sql defines the baseline.
- 002.up.ts runs 002.prepare.sql, the fixed signed projection, then 002.finish.sql.
- 003.up.sql installs the graph change feed.
- current-schema.sql describes the complete latest schema independently; db:init uses it directly.
- schema-state.ts only checks the version and is the sole schema dependency of server startup.
- runtime.ts loads SQL batches without splitting on semicolons; schema.ts owns the
  dedicated connection transaction and version ledger for every pending up operation.

The projection remains TypeScript because Math.imul and unsigned shifts define its exact
32-bit arithmetic. Server and browser migrations carry their own frozen version-specific
conversion code; core exports no legacy conversion or archive API. New versions must add
new numbered up files and registry entries; never edit an applied migration to change its result.
A down migration, if added later, must have its own numbered down file and run transactionally.

The server build copies SQL files beside the compiled migration modules. Source CLI and
compiled startup therefore use the same SQL assets.

To inspect archived server rows, use the explicit-target migration CLI:

```sh
pnpm --filter @labby/server db:migrate --pglite /absolute/path/to/test-db --action archive
```

There is no business HTTP endpoint or LabbyDB store method for these rows. Browser archives
remain in the local migration table for one-time recovery tooling, outside normal business exports.


With the server environment configured, no connection argument is needed:

```sh
pnpm --filter @labby/server db:migrate --action status
pnpm --filter @labby/server db:migrate
```

The first command only inspects; the second applies migrations and prints a success message only
after commit and a subsequent schema check. Errors exit nonzero. Migration progress is explicitly
marked uncommitted until the transaction succeeds. Empty databases are directed to db:init rather
than being silently initialized by db:migrate.
