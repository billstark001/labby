# Railway deployment and Cron

## Architecture

The application has one job-scheduler interface and two job groups. Authentication cleanup and configured backups have fixed schedules. Email tasks and schedule notifications are defined by database rows and can change at runtime. In production, `STATIC_SCHEDULER_MODE=external` gives fixed jobs to Railway Cron and `DYNAMIC_SCHEDULER_MODE=cloud` gives dynamic jobs to Cloud Scheduler. The checked-in IaC declares the API and the fixed authentication-cleanup Cron service; add a separate Railway Cron service if scheduled backups are enabled.

`STATIC_SCHEDULER_MODE` accepts `cron`, `cloud`, or `external`; `DYNAMIC_SCHEDULER_MODE` accepts `cron` or `cloud`. Outside production, omitted values default to local `node-cron`; production requires both explicitly. Local timers require one always-on API replica. `cloud` mirrors the selected group to Cloud Scheduler. `external` retains fixed handlers for Railway Cron callbacks without starting local timers or mirroring those jobs. Configure exactly one trigger for each fixed job. Cloud Scheduler reconciliation is awaited before the API becomes healthy and after database-defined schedules change. On dispatch, an API replica reloads dynamic definitions from the database. A database ledger claims each Cloud Scheduler schedule time or Railway Cron HTTP retry ID once across replicas. Claiming before side effects prevents duplicate execution; a process crash after claiming can require manual recovery of a missed run. Cloud Scheduler job retries are disabled to avoid replaying partially completed email deliveries.

Railway infrastructure is managed with the current Infrastructure-as-Code format in `.railway/railway.ts`. Run `pnpm railway:plan` before `pnpm railway:apply`; the wrapper installs the pinned IaC authoring SDK into the ignored `.cache/` directory when needed. The SDK is deployment tooling, not an application development dependency. Secrets are represented with `preserve()` and remain stored in Railway. The deprecated `railway.json` format must not be reintroduced because a repository-wide file is also applied to Cron uploads and can override their one-shot configuration.

Deployment environment resolution uses env-lane. The API deployment reads `packages/server/.env` and then optional `packages/server/.env.railway.production`; the Cron deployment uses the same package base and optional `packages/server/.env.railway.cron.production`. Shell variables select the Railway project/service but are not implicitly copied into the service environment. Only the runtime-variable allowlist is synchronized. A repository-root `.env` is never read.
The complete command-to-file matrix and precedence rules are documented in
[environment-files.md](environment-files.md).

## API/web service

1. Link the repository to the Railway project and environment, then review and apply `.railway/railway.ts`.
2. Configure `DATABASE_URL` for the existing durable PostgreSQL database (for example Neon), `DB_DRIVER=postgres`, authentication secrets, `WEB_DIST_DIR=/app/packages/web/dist`, `PUBLIC_BASE_URL`, `STATIC_SCHEDULER_MODE=external`, `DYNAMIC_SCHEDULER_MODE=cloud`, `SCHEDULER_DISPATCH_API_KEY`, `CLOUD_SCHEDULER_PROJECT_ID`, and `CLOUD_SCHEDULER_LOCATION`. Do not create another database when the environment already supplies one. The JSON credential file can supply the project ID during deployment.
   For Google integrations, prefer `GOOGLE_OAUTH_CLIENT_ID` plus `GOOGLE_OAUTH_CLIENT_SECRET`; Railway variables do not materialize `GOOGLE_OAUTH_JSON_PATH` as a file. For mail on Railway Hobby, set `SMTP_PROVIDER=gmail-api`, `GMAIL_USER`, and `SMTP_FROM` to use the Gmail HTTPS API. Supply `GMAIL_REFRESH_TOKEN` for Gmail and/or `GOOGLE_OAUTH_REFRESH_TOKEN` for Google Drive. A shared token may serve both only when it was authorized with both scopes.
3. The IaC declaration sets `sleepApplication=false` and places the API and Cron service in Railway Singapore (`asia-southeast1-eqsg3a`), near the current Neon `ap-southeast-1` endpoint. Redeploy after changing this setting because Railway applies it when it creates the container. The PostgreSQL pool has a maximum of eight connections per API instance, a 15-second connection timeout and a 60-second idle timeout. If the database region changes, review this choice again.
4. Declare the public domain and its target port in IaC. The target must match Railway's injected `PORT` (currently `8080`); targeting the application's local-development default will pass the container health check but make public requests fail.

Run a full deployment with:

```sh
pnpm deploy:railway
```

Environment synchronization runs before upload. An assignment such as `SMTP_PASSWORD=` is an explicit empty value and is synchronized as an empty string; omission leaves the remote variable unchanged. Remote deletion is never inferred from omission and must be requested explicitly:

```sh
pnpm deploy:railway --delete-env SMTP_PASSWORD
RAILWAY_SERVICE=custom-cron pnpm deploy:railway:cron --delete-env LABBY_CRON_ATTEMPTS
```

Use `--delete-env KEY_A,KEY_B` or repeat the option. `--env-build <build>` selects a different configured env-lane build. `--no-env-sync` skips synchronization, and cannot be combined with deletion. Railway values are sent through stdin so secrets are not included in CLI arguments.

### Credential files in env-lane

For Cloud Scheduler, configure either `GOOGLE_CLOUD_CLIENT_EMAIL` and `GOOGLE_CLOUD_PRIVATE_KEY` together, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file. The file's `project_id` fills `CLOUD_SCHEDULER_PROJECT_ID` when that setting is empty. A project ID from the same or a later env-lane file must match; a project ID inherited from an earlier file is replaced. On Cloud Run, leave both explicit fields empty to use the attached service identity through ADC. The Cloud Scheduler account needs permission to list, create, update, and delete jobs in the chosen project.

The Railway deployment planner also expands the existing portable Google OAuth file settings:

| Local path setting | Railway runtime fields extracted when the file is selected |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | `GOOGLE_CLOUD_CLIENT_EMAIL`, `GOOGLE_CLOUD_PRIVATE_KEY`, and optionally `CLOUD_SCHEDULER_PROJECT_ID` |
| `GOOGLE_OAUTH_JSON_PATH` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| `GOOGLE_OAUTH_REFRESH_TOKEN_PATH` | `GOOGLE_OAUTH_REFRESH_TOKEN` |

Paths can be absolute or relative to the env-lane file that supplied the path. The planner reads the final selection across the base `.env` and the selected lane file. A selected file path replaces direct fields inherited from an earlier file. Complete direct field groups in the same or a later file take precedence and skip reading; partial groups and conflicting values are rejected. Credential files must be regular files owned by the deploying user, mode `0600` or stricter, at most 64 KiB, and not symlinks. Their paths and contents are never printed or sent to Railway; only extracted runtime fields are synchronized. Files beginning with `google-` are excluded from Git, Railway CLI upload, and Docker build context. Keep the local files out of other upload paths as well.

Railway CLI can set variables from stdin but cannot seal them. After first synchronization, seal `GOOGLE_CLOUD_PRIVATE_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` in the API service's Variables tab. Existing sealed variables cannot be compared with local values by CLI. If a local file would expand into an already sealed variable, deployment stops before changing remote variables; rotate that value through the dashboard or remove the file-path setting from the private env file so future deployments retain the sealed value.

Use `pnpm deploy:railway:incremental` for a conditional deployment. It still uploads a complete build, but skips the upload when the merge-base diff contains no API/web runtime files. If the diff base resolves to `HEAD` (as `origin/main` often does when deploying from `main`) or a safe diff base cannot be resolved, it deploys rather than silently skipping.

## Fixed Railway Cron service

With `STATIC_SCHEDULER_MODE=external`, the checked-in `labby-auth-cleanup` service uses the one-shot start command `node packages/server/dist/cron/railway-dispatch.js`. Configure:

- `LABBY_SERVER_URL`: the public HTTPS URL of the API service.
- `SCHEDULER_DISPATCH_API_KEY`: the same secret as the API service.
- `LABBY_CRON_JOB`: the exact fixed job name `auth-maintenance-cleanup`. A separate backup service may use `database-backup`. Dynamic `schedule-notify:*` and `email-task:*` jobs must not use Railway Cron.
- `LABBY_CRON_TIMEOUT_MS` (optional): per-request timeout in milliseconds; default `120000`.
- `LABBY_CRON_ATTEMPTS` (optional): total attempts for network and 502/503/504 failures; default `3`.

Set a distinct `deploy.cronSchedule` in each IaC service, matching the server's fixed-job expression and timezone. The checked-in auth cleanup schedule is `17 3 * * *` UTC. Railway Cron uses UTC five-field expressions and has a five-minute minimum interval. The process exits after dispatch; a non-2xx application response fails the execution, while transient gateway failures are retried with bounded backoff using the same dispatch ID. A separate platform invocation gets a new ID, so backup targets still need their own idempotency policy.

Deploy the Cron service with:

```sh
pnpm deploy:railway:cron
# or, for a conditional upload
pnpm deploy:railway:cron:incremental
```

## Deployment variables

- `RAILWAY_SERVICE`: optional service name or ID override; defaults to `labby-api` for API and `labby-auth-cleanup` for Cron.
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

Before changing Railway IaC, run `pnpm railway:plan` and review additions, updates, and deletions. Set `STATIC_SCHEDULER_MODE=external` and `DYNAMIC_SCHEDULER_MODE=cloud` in the private Railway env-lane file before applying the checked-in Cron service; local fixed-job timers together with the Railway Cron trigger would run auth cleanup twice. Remove the obsolete `SCHEDULER_MODE` variable explicitly with `--delete-env SCHEDULER_MODE` during the later deployment. Apply the reviewed plan, deploy API and Cron, and check `/health`, login/refresh, replica count, Cloud Scheduler jobs, and dispatcher logs. Keeping the existing Neon endpoint does not require a database copy. A schema migration still requires its own external backup and explicit migration procedure.

**Verify replica placement separately.** Check `railway status --json` after apply; the plan alone does not prove where the live replicas run. The API and fixed Cron service should both run in Singapore. If placement drifts, use [Railway's scale command](https://docs.railway.com/cli/scale) and recheck the actual running replicas. Local `cron` mode still requires exactly one always-on API replica.

Compare the same routes and data volume before and after rollout over a bounded observation window: `/api/v1/db/persons`, `/api/v1/db/person-tags`, and `/api/v1/db/foreign-keys/person`. Record p50/p95 latency, status counts, body size where the response exposes `content-length`, and `http_request` request IDs, `dbQueries`, `dbDurationMs`, and pool total/idle/waiting. `db_slow` records queries over 250 ms and the initial schema connection; its read/write duration includes possible connection wait. `request_error` and `db_pool_error` classify errors without SQL parameters or recipient addresses. Correlate those timestamps with Neon connection count, compute wakeups, CPU, and query statistics. In particular, repeat cold start, concurrent refresh, and an access after 30 minutes idle. A provisional target is p95 below one second for small lists and the person reference endpoint, with a much smaller foreign-key response and no connection `ETIMEDOUT`. If the target fails, use the correlated measurements to separate connection wait, database execution, and application response time before adjusting pool or indexes. Do not report local PGlite test times as Railway latency.

If the rollout worsens service, restore the prior IaC and deployment settings, review the plan, apply and redeploy API and Cron. Schema version 9 must be applied with the [explicit migration CLI](database-migrations.md) before starting server code that requires it. Do not start old server code against a migrated schema as an untested rollback.

- Rotate the dispatch key in the API service and every Cron service together; Cloud Scheduler jobs are updated by the next successful reconciliation.
- Never expose the key in the repository, URL, or command line.
- Use HTTPS for `LABBY_SERVER_URL`; plain HTTP is accepted only for localhost testing.
- Railway may skip a Cron occurrence while its previous execution is still active. Railway's in-process HTTP retries reuse one dispatch ID; an entirely new platform invocation gets a new ID. Keep fixed handlers idempotent and bounded.
- Inspect API startup logs for the mode and both job counts, Cloud Scheduler's dynamic job list, `[railway-cron] Dispatched ...`, and API handler failures.
