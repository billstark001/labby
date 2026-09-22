# Labby engineering standards

## Scheduled jobs and deployment

1. A scheduled operation has one stable scheduler name and one idempotent handler. Registration belongs in the server; provider adapters only trigger that name.
2. Production callbacks use `POST /internal/scheduler/dispatch` and `X-Api-Key`. Secrets stay in provider variables. Never put credentials in URLs or source files.
3. Select exactly one execution owner per environment: local cron, Cloud Scheduler, or Railway Cron. Hybrid mode is for controlled migration only.
4. Serverless deployments use durable PostgreSQL and remote object/email backup targets. Never rely on an instance filesystem.
5. Full deployment is the explicit recovery path. Incremental deployment may only skip when the diff contains no Docker, workspace, core, server, or web runtime changes.

## Dialogs

1. Use `components/ui/Dialog`, not the headless primitive in feature code.
2. The shared header owns the title, close button, divider, and horizontal padding. Feature content must not add a second title or close control.
3. Put primary/secondary controls in `actions`; dialog body content must not compensate for container edge padding.
4. Every dialog is dismissible by its labelled close button and Escape. Disable overlay dismissal only when accidental dismissal can lose work.

## Loading and query state

1. Initial content loading uses `ContentSkeleton` (or composed `Skeleton` shapes), preserves layout, and has an accessible status. Do not render plain “Loading…” content or an indefinite spinner in a content region.
2. Mutations may use button busy states or loading toasts. A skeleton is not used for a user-triggered mutation.
3. Data fetching must expose the common `idle | pending | success | error` state contract. New Preact screens use `useAsyncResource` unless a feature adopts a query library for the whole boundary.
4. Keep stale successful data visible during refetch, render errors explicitly, and prevent older requests from overwriting newer results.
5. Query keys/dependencies must include every value read by the fetch operation. After a mutation, refetch or update the cached value rather than maintaining a second source of truth.
