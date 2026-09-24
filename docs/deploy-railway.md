# Railway deployment and Cron

## Architecture

Labby uses two Railway service types built from the same Dockerfile:

- The API/web service is a request-driven service. `SCHEDULER_MODE=external` registers scheduled handlers without starting `node-cron` or a Cloud Scheduler mirror.
- Each Railway Cron service is a one-shot trigger. Its compiled entry point calls the authenticated server dispatch endpoint for one `LABBY_CRON_JOB`; the server remains the owner of the handler and its stable job name.

Railway's Cron schedule is service configuration, so create one Cron service for each independently scheduled job. The checked-in `.railway/railway.ts` currently declares the API service and the authentication-maintenance Cron service. Do not run the same job through local cron, Cloud Scheduler, and Railway Cron at the same time.

Railway infrastructure is managed with the current Infrastructure-as-Code format in `.railway/railway.ts`. Run `pnpm railway:plan` before `pnpm railway:apply`; the wrapper installs the pinned IaC authoring SDK into the ignored `.cache/` directory when needed. The SDK is deployment tooling, not an application development dependency. Secrets are represented with `preserve()` and remain stored in Railway. The deprecated `railway.json` format must not be reintroduced because a repository-wide file is also applied to Cron uploads and can override their one-shot configuration.

Deployment environment resolution uses env-lane. The API deployment reads `packages/server/.env` and then optional `packages/server/.env.railway.production`; the Cron deployment uses the same package base and optional `packages/server/.env.railway.cron.production`. Shell variables select the Railway project/service but are not implicitly copied into the service environment. Only the runtime-variable allowlist is synchronized. A repository-root `.env` is never read.
The complete command-to-file matrix and precedence rules are documented in
[environment-files.md](environment-files.md).

## API/web service

1. Link the repository to the Railway project and environment, then review and apply `.railway/railway.ts`.
2. Configure `DATABASE_URL` for the existing durable PostgreSQL database (for example Neon), `DB_DRIVER=postgres`, authentication secrets, `WEB_DIST_DIR=/app/packages/web/dist`, `PUBLIC_BASE_URL`, `SCHEDULER_MODE=external`, and a strong `SCHEDULER_DISPATCH_API_KEY`. Do not create another database when the environment already supplies one.
   For Google integrations, prefer `GOOGLE_OAUTH_CLIENT_ID` plus `GOOGLE_OAUTH_CLIENT_SECRET`; Railway variables do not materialize `GOOGLE_OAUTH_JSON_PATH` as a file. For mail on Railway Hobby, set `SMTP_PROVIDER=gmail-api`, `GMAIL_USER`, and `SMTP_FROM` to use the Gmail HTTPS API. Supply `GMAIL_REFRESH_TOKEN` for Gmail and/or `GOOGLE_OAUTH_REFRESH_TOKEN` for Google Drive. A shared token may serve both only when it was authorized with both scopes.
3. The IaC declaration sets `sleepApplication=false` for the API and places API/Cron in Railway Singapore (`asia-southeast1-eqsg3a`), near the current Neon `ap-southeast-1` endpoint. Redeploy after changing this setting because Railway applies it when it creates the container. The PostgreSQL pool has a maximum of eight connections per API instance, a 15-second connection timeout and a 60-second idle timeout. If the database region changes, review this choice again.
4. Declare the public domain and its target port in IaC. The target must match Railway's injected `PORT` (currently `8080`); targeting the application's local-development default will pass the container health check but make public requests fail.

Run a full deployment with:

```sh
pnpm deploy:railway
```

Environment synchronization runs before upload. An assignment such as `SMTP_PASSWORD=` is an explicit empty value and is synchronized as an empty string; omission leaves the remote variable unchanged. Remote deletion is never inferred from omission and must be requested explicitly:

```sh
pnpm deploy:railway --delete-env SMTP_PASSWORD
pnpm deploy:railway:cron --delete-env LABBY_CRON_ATTEMPTS
```

Use `--delete-env KEY_A,KEY_B` or repeat the option. `--env-build <build>` selects a different configured env-lane build. `--no-env-sync` skips synchronization, and cannot be combined with deletion. Railway values are sent through stdin so secrets are not included in CLI arguments.

Use `pnpm deploy:railway:incremental` for a conditional deployment. It still uploads a complete build, but skips the upload when the merge-base diff contains no API/web runtime files. If the diff base resolves to `HEAD` (as `origin/main` often does when deploying from `main`) or a safe diff base cannot be resolved, it deploys rather than silently skipping.

## Cron service

Declare another service in `.railway/railway.ts`, using the same Dockerfile with the one-shot start command `node packages/server/dist/cron/railway-dispatch.js`. Configure:

- `LABBY_SERVER_URL`: the public HTTPS URL of the API service.
- `SCHEDULER_DISPATCH_API_KEY`: the same secret as the API service.
- `LABBY_CRON_JOB`: an exact registered name, such as `database-backup`, `auth-maintenance-cleanup`, `schedule-notify:<config-id>`, or `email-task:<task-id>`.
- `LABBY_CRON_TIMEOUT_MS` (optional): per-request timeout in milliseconds; default `120000`.
- `LABBY_CRON_ATTEMPTS` (optional): total attempts for network and 502/503/504 failures; default `3`.

Set a distinct `deploy.cronSchedule` in each IaC service. Railway Cron uses UTC five-field expressions and has a five-minute minimum interval. Declare another service for each independently scheduled job. The process exits after the dispatch finishes; a non-2xx application response fails the execution, while transient cold-start gateway failures are retried with bounded backoff.

Deploy the Cron service with:

```sh
pnpm deploy:railway:cron
# or, for a conditional upload
pnpm deploy:railway:cron:incremental
```

## Deployment variables

- `RAILWAY_SERVICE`: optional service name or ID override. By default, API commands target `labby-api` and Cron commands target `labby-auth-cleanup`, regardless of the CLI-linked service.
- `RAILWAY_ENVIRONMENT`: environment name or ID.
- `RAILWAY_PROJECT_ID`: project ID; when supplied, also supply an environment.
- `RAILWAY_CLI`: alternate Railway executable path.
- `DEPLOY_DIFF_BASE`: explicit Git ref for incremental comparison. Otherwise `origin/main`, `main`, then `HEAD^` are tried.
- `RAILWAY_DETACH=true`: queue the build and return immediately. By default the script uses Railway CI mode and returns failure when the build fails; verify the deployment health after the command succeeds.
- `--env-build`: env-lane build name; defaults to `railway.production` for API and `railway.cron.production` for Cron.
- `--no-env-sync`: deploy without reading or changing service variables.
- `--delete-env KEY`: explicitly delete one or more managed variables; omitted variables are retained.

## Operations

### Production rollout and measurement

The 2026-09-24 audit found cross-region API/database placement and connection `ETIMEDOUT`, but did not establish a single cause. The checked-in region and sleep changes are **configuration only until applied and redeployed**. Before applying them, take an external database backup, record the current API/Cron service region and sleep settings, verify the target region is supported by the project, and run `pnpm railway:plan`. The current reviewed plan has **0 destructive changes**; the IaC file preserves existing Cron variables even though Cron deployment sync uses a narrower allowlist. Apply with `pnpm railway:apply`, deploy API and Cron from a reviewed revision, then check `/health` and login/refresh. No database copy is needed when retaining the same Neon endpoint; do not create a new database as part of this move.

**Verify replica placement separately.** On 2026-09-24, `railway status --json` still reported `us-east4-eqdc4a` for both services while the IaC desired graph said `asia-southeast1-eqsg3a`; `railway config plan` listed only the sleep change. Therefore an IaC apply alone has not been shown to move replicas. After applying, check `railway status --json` again. If still in US East, use [Railway's scale command](https://docs.railway.com/cli/scale) to add one Southeast Asia replica for each service, confirm live placement and health, and then set the US East replica to zero. Keep the checked-in IaC region aligned with that final state and re-run the plan. Do not infer placement from the plan's summary.

Compare the same routes and data volume before and after rollout over a bounded observation window: `/api/v1/db/persons`, `/api/v1/db/person-tags`, and `/api/v1/db/foreign-keys/person`. Record p50/p95 latency, status counts, body size where the response exposes `content-length`, and `http_request` request IDs, `dbQueries`, `dbDurationMs`, and pool total/idle/waiting. `db_slow` records queries over 250 ms and the initial schema connection; its read/write duration includes possible connection wait. `request_error` and `db_pool_error` classify errors without SQL parameters or recipient addresses. Correlate those timestamps with Neon connection count, compute wakeups, CPU, and query statistics. In particular, repeat cold start, concurrent refresh, and an access after 30 minutes idle. A provisional target is p95 below one second for small lists and the person reference endpoint, with a much smaller foreign-key response and no connection `ETIMEDOUT`. If the target fails, use the correlated measurements to separate connection wait, database execution, and application response time before adjusting pool or indexes. Do not report local PGlite test times as Railway latency.

If the rollout worsens service, restore the previous IaC region/sleep settings, review the plan, apply and redeploy API/Cron. The external database backup is the recovery source for a failed schema migration; changing Railway region alone does not mutate the database. Schema version 8 must be applied with the [explicit migration CLI](database-migrations.md) before starting new server code. Do not start old server code against a migrated schema as an untested rollback.

- Rotate the dispatch key in the API service and every Cron service together.
- Never expose the key in the repository, URL, or command line.
- Use HTTPS for `LABBY_SERVER_URL`; plain HTTP is accepted only for localhost testing.
- Railway may skip a Cron occurrence while its previous execution is still active. Keep handlers idempotent and bounded.
- Inspect Cron logs for `[railway-cron] Dispatched ...` and API logs for handler failures.
