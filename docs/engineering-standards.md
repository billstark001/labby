# Labby engineering standards

## Scheduled jobs and deployment

1. A scheduled operation has one stable scheduler name and one idempotent handler. Registration belongs in the server; provider adapters only trigger that name.
2. Production callbacks use `POST /internal/scheduler/dispatch` and `X-Api-Key`. Secrets stay in provider variables. Never put credentials in URLs or source files.
3. Select exactly one execution owner per environment: local cron, Cloud Scheduler, or Railway Cron. Hybrid mode is for controlled migration only.
4. Serverless deployments use durable PostgreSQL and remote object/email backup targets. Never rely on an instance filesystem.
5. Provider configuration must use fields verified against the provider's current schema. Railway Serverless is declared with `deploy.sleepApplication` and requires a redeploy before it affects the running container. Public domains route to Railway's injected `PORT`, not a local-development default.
6. Production one-shot jobs execute compiled artifacts from the production image. They must not depend on development-only runners such as `tsx`.
7. Full deployment is the explicit recovery path. Incremental deployment is a conditional full upload, may skip only when no target runtime file changed, and must deploy when its diff base cannot be established safely.
8. Unknown scheduler modes and external mode without dispatch authentication fail at startup. Dispatch clients use HTTPS, retry only transient network/gateway failures, and surface application failures.
9. Railway resources are declared in `.railway/railway.ts`; deprecated repository-wide `railway.json` files are forbidden because they can override per-service API and Cron settings. Plans are reviewed before they are applied, secrets use `preserve()` rather than source-controlled values, and the pinned Railway IaC authoring SDK is installed on demand outside the application dependency graph.
10. Container builds pin the package-manager version to the same exact version recorded by the lockfile. Production installs use a frozen lockfile so toolchain drift fails before deployment.
11. Application runtime code consumes `process.env` and does not load dotenv files. Local server commands use Node's native env-file flags; database package scripts inject package-local layers with `env-lane run` rather than calling env-lane from application code; deployment tooling may use the env-lane API and synchronizes only an explicit allowlist.
12. Environment omission means “leave remote value unchanged”, an explicit empty assignment means “set empty”, and deletion requires a named command-line argument. Synchronizers must redact values from logs and must not pass Railway secrets in command arguments.
13. Env-file layout follows checked-in example templates. Use env-lane sorting explicitly; sorting must preserve values and comments, skip absent private files, and never change resolution precedence. Provider override files and nested package env files must be excluded from container build contexts.
14. Every env file belongs to the package that consumes it. Project commands must not load a repository-root `.env`; server provider overrides and their examples live under `packages/server`, while Vite files live under `packages/web`.

## Dialogs

1. Use `components/ui/Dialog`, not the headless primitive in feature code.
2. The shared header owns the title, close button, divider, and horizontal padding. Feature content must not add a second title or close control.
3. Put primary/secondary controls in `actions`; dialog body content must not compensate for container edge padding.
4. Every dialog is dismissible by its labelled close button and Escape. Disable overlay dismissal only when accidental dismissal can lose work.
5. Long content scrolls inside the body; the header and action row remain visible. Dialogs expose an accessible name, trap keyboard focus, lock background scrolling, and restore prior focus on close.

## Loading and query state

1. Initial content loading uses `ContentSkeleton` (or composed `Skeleton` shapes), preserves layout, and has a localized accessible status. Do not render plain “Loading…” content or an indefinite spinner in a content region.
2. Mutations may use button busy states or loading toasts. A skeleton is not used for a user-triggered mutation.
3. Data fetching must expose the common `idle | pending | success | error` state contract. New Preact screens use `useAsyncResource` unless a feature adopts a query library for the whole boundary.
4. Keep stale successful data visible during refetch, mark the region busy, render errors with a recovery action, and prevent older requests from overwriting newer results.
5. Query keys/dependencies must include every value read by the fetch operation. After a mutation, refetch or update the cached value rather than maintaining a second source of truth.
6. Database initialization only makes the database usable; it does not make entity collections ready. Render an empty state or declare a requested entity missing only after a successful query for the current query key. A failed read is an error, never an empty result or a deletion.
7. A list row and the related names, permissions, or reference counts used to render or act on it form one content boundary. Fetch them together and publish one complete result. Gate edit, delete, save, send, and computation controls until their required data is ready. An ID fallback is reserved for a confirmed dangling reference after the related lookup succeeds.
8. Keep stale data only while refetching the same query key. Changing a route ID, page, sort order, selected configuration, or account session must hide the prior result until the new key succeeds. Guard late responses so they cannot publish into another key or a previous session.
9. Page-scoped subsets and paginated results belong to their owning query. Never replace a global full collection with a foreign-key subset or a page of results. Forms for existing entities mount only after their initial values have loaded; programmatic editor updates must not mark them dirty.
10. Every initial content query exposes an in-region error and retry action. Tests for these boundaries delay the entity and related reads independently, and cover genuine absence, read failure, key changes, and out-of-order completion.
11. Every user-initiated asynchronous action shows a visible pending state from submission until settlement, prevents duplicate submission, and reports failure in its owning context. Background work that can affect displayed data exposes a non-disruptive progress or stale-data state. Success feedback must mean the operation actually completed.

## API and production performance

1. Authentication state changes only on a confirmed authentication failure. A refresh request returning 5xx or a network error preserves the session and surfaces a retryable service error; it must not be converted into a 401 or 403. A 403 is displayed as a permission error without invalidating the session.
2. Production API latency investigations record a bounded observation window, route-level latency, failure class, service and database regions, and connection-versus-query evidence before attributing a cause. Logs and audit documents omit credentials, token values, email addresses, and raw request payloads.
3. Paginated API reads perform bounded database work. Related-data bundles load only the fields and rows required by their caller, and avoid repeated cross-region round trips where a single set-based query can serve the request.

## Scheduling and people

1. Solver documentation distinguishes the current objective, hard validity rules, initialization guidance, and search behavior. A user-facing constraint is evaluated in the final objective or enforced as a hard rule; an initial-assignment preference alone is not sufficient.
2. People and tags can both be constraint targets. Pair constraints must be able to target either one group or two different groups; frequency constraints resolve their targets against the active people at solve time. Existing person-only constraints remain readable when the schema evolves.
3. Solver changes are evaluated with fixed seeds and representative histories. Record initial and final objective values, per-person presentation gaps, same-session reciprocal presenter/questioner pairs, hard-rule violations, and runtime. A lower aggregate objective alone does not establish acceptable schedule quality.
4. A schedule's highlight controls support multiple people and tags. Context actions for highlighting remain available outside manual edit mode; highlight-only presentation does not mutate the schedule.

## Manual email delivery

1. Immediate email delivery presents the effective recipient addresses for review and allows an explicit one-off override. A one-off override does not silently change the saved task's scheduled recipients.
2. The API validates recipient addresses and returns a delivery outcome. The UI reports success only when at least one intended delivery succeeded, and shows a pending state until the delivery result is known.

## UI text and shared components

1. User-visible reusable copy belongs in the generated i18n dictionaries. Shared status components obtain their accessible labels from the current locale; hard-coded English is not an acceptable fallback in rendered UI.
2. Feature code uses the shared `Button`, `Dialog`, `Toast`, `Skeleton`, responsive-data, and form styles before adding a local equivalent.
3. Content-query failures render in their owning region. Mutation failures use an inline form error or toast and must not overwrite query state.

## Runtime configuration and verification

1. Required production configuration is validated at startup or at the one-shot entry point. Secrets are never included in logs or thrown error messages.
2. Server mode uses PostgreSQL; local PGlite state and instance files are not production durability mechanisms.
3. A change is complete only after relevant type checks and tests pass. Scheduling, deployment selection, authentication, retry behavior, and shared UI state require focused regression tests when changed.
4. Deployment success includes provider-side build completion and a live health check; accepting an upload or creating a deployment record is not sufficient.
