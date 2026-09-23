# Labby engineering standards

## Scheduled jobs and deployment

1. A scheduled operation has one stable scheduler name and one idempotent handler. Registration belongs in the server; provider adapters only trigger that name.
2. Production callbacks use `POST /internal/scheduler/dispatch` and `X-Api-Key`. Secrets stay in provider variables. Never put credentials in URLs or source files.
3. Select exactly one execution owner per environment: local cron, Cloud Scheduler, or Railway Cron. Hybrid mode is for controlled migration only.
4. Serverless deployments use durable PostgreSQL and remote object/email backup targets. Never rely on an instance filesystem.
5. Provider configuration must use fields verified against the provider's current schema. Railway Serverless is declared with `deploy.sleepApplication` and requires a redeploy before it affects the running container.
6. Production one-shot jobs execute compiled artifacts from the production image. They must not depend on development-only runners such as `tsx`.
7. Full deployment is the explicit recovery path. Incremental deployment is a conditional full upload, may skip only when no target runtime file changed, and must deploy when its diff base cannot be established safely.
8. Unknown scheduler modes and external mode without dispatch authentication fail at startup. Dispatch clients use HTTPS, retry only transient network/gateway failures, and surface application failures.
9. Railway resources are declared in `.railway/railway.ts`; deprecated repository-wide `railway.json` files are forbidden because they can override per-service API and Cron settings. Plans are reviewed before they are applied, and secrets use `preserve()` rather than source-controlled values.
10. Container builds pin the package-manager version to the same exact version recorded by the lockfile. Production installs use a frozen lockfile so toolchain drift fails before deployment.

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

## UI text and shared components

1. User-visible reusable copy belongs in the generated i18n dictionaries. Shared status components obtain their accessible labels from the current locale; hard-coded English is not an acceptable fallback in rendered UI.
2. Feature code uses the shared `Button`, `Dialog`, `Toast`, `Skeleton`, responsive-data, and form styles before adding a local equivalent.
3. Content-query failures render in their owning region. Mutation failures use an inline form error or toast and must not overwrite query state.

## Runtime configuration and verification

1. Required production configuration is validated at startup or at the one-shot entry point. Secrets are never included in logs or thrown error messages.
2. Server mode uses PostgreSQL; local PGlite state and instance files are not production durability mechanisms.
3. A change is complete only after relevant type checks and tests pass. Scheduling, deployment selection, authentication, retry behavior, and shared UI state require focused regression tests when changed.
4. Deployment success includes provider-side build completion and a live health check; accepting an upload or creating a deployment record is not sufficient.
