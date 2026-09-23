# Railway deployment and Cron

## Architecture

Labby uses two Railway service types built from the same Dockerfile:

- The API/web service is a request-driven service. `SCHEDULER_MODE=external` registers scheduled handlers without starting `node-cron` or a Cloud Scheduler mirror.
- Each Railway Cron service is a one-shot trigger. Its compiled entry point calls the authenticated server dispatch endpoint for one `LABBY_CRON_JOB`; the server remains the owner of the handler and its stable job name.

Railway's Cron schedule is service configuration, so create one Cron service for each independently scheduled job. The checked-in `.railway/railway.ts` currently declares the API service and the authentication-maintenance Cron service. Do not run the same job through local cron, Cloud Scheduler, and Railway Cron at the same time.

Railway infrastructure is managed with the current Infrastructure-as-Code format in `.railway/railway.ts`. Run `pnpm railway:plan` before `pnpm railway:apply`; secrets are represented with `preserve()` and remain stored in Railway. The deprecated `railway.json` format must not be reintroduced because a repository-wide file is also applied to Cron uploads and can override their one-shot configuration.

Deployment environment resolution uses env-lane. The API deployment reads the repository `.env` and then optional `.env.railway.production`; the Cron deployment uses `.env` and optional `.env.railway.cron.production`. Shell variables select the Railway project/service but are not implicitly copied into the service environment. Only the runtime-variable allowlist is synchronized.

## API/web service

1. Link the repository to the Railway project and environment, then review and apply `.railway/railway.ts`.
2. Configure `DATABASE_URL` for the existing durable PostgreSQL database (for example Neon), `DB_DRIVER=postgres`, authentication secrets, `WEB_DIST_DIR=/app/packages/web/dist`, `PUBLIC_BASE_URL`, `SCHEDULER_MODE=external`, and a strong `SCHEDULER_DISPATCH_API_KEY`. Do not create another database when the environment already supplies one.
3. The IaC declaration sets `sleepApplication=true`. Redeploy after changing this setting because Railway applies Serverless when it creates the container. The PostgreSQL pool releases idle connections so the service can become inactive.
4. Declare the public domain and its target port in IaC. The target must match Railway's injected `PORT` (currently `8080`); targeting the application's local-development default will pass the container health check but make public requests fail. A sleeping service is woken by the Cron request.

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

Use `pnpm deploy:railway:incremental` for a conditional deployment. It still uploads a complete build, but skips the upload when the merge-base diff contains no API/web runtime files. If a safe diff base cannot be resolved, it deploys rather than silently skipping.

## Cron service

Declare another service in `.railway/railway.ts`, using the same Dockerfile with the one-shot start command `node packages/server/dist/cron/railway-dispatch.js`. Configure:

- `LABBY_SERVER_URL`: the public HTTPS URL of the API service.
- `SCHEDULER_DISPATCH_API_KEY`: the same secret as the API service.
- `LABBY_CRON_JOB`: an exact registered name, such as `database-backup`, `auth-maintenance-cleanup`, `schedule-notify:<config-id>`, or `email-task:<task-id>`.
- `LABBY_CRON_TIMEOUT_MS` (optional): per-request timeout in milliseconds; default `120000`.
- `LABBY_CRON_ATTEMPTS` (optional): total attempts for network and 502/503/504 failures; default `3`.

Set a distinct `deploy.cronSchedule` in each IaC service. Railway Cron uses UTC five-field expressions and has a five-minute minimum interval. Declare another service for each independently scheduled job. The process exits after the dispatch finishes; a non-2xx application response fails the execution, while transient cold-start gateway failures are retried with bounded backoff.

Deploy the Cron service with `RAILWAY_SERVICE` targeting that service:

```sh
pnpm deploy:railway:cron
# or, for a conditional upload
pnpm deploy:railway:cron:incremental
```

## Deployment variables

- `RAILWAY_SERVICE`: service name or ID. Strongly recommended when the project has both API and Cron services.
- `RAILWAY_ENVIRONMENT`: environment name or ID.
- `RAILWAY_PROJECT_ID`: project ID; when supplied, also supply an environment.
- `RAILWAY_CLI`: alternate Railway executable path.
- `DEPLOY_DIFF_BASE`: explicit Git ref for incremental comparison. Otherwise `origin/main`, `main`, then `HEAD^` are tried.
- `RAILWAY_DETACH=true`: queue the build and return immediately. By default the script uses Railway CI mode and returns failure when the build fails; verify the deployment health after the command succeeds.
- `--env-build`: env-lane build name; defaults to `railway.production` for API and `railway.cron.production` for Cron.
- `--no-env-sync`: deploy without reading or changing service variables.
- `--delete-env KEY`: explicitly delete one or more managed variables; omitted variables are retained.

## Operations

- Rotate the dispatch key in the API service and every Cron service together.
- Never expose the key in the repository, URL, or command line.
- Use HTTPS for `LABBY_SERVER_URL`; plain HTTP is accepted only for localhost testing.
- Railway may skip a Cron occurrence while its previous execution is still active. Keep handlers idempotent and bounded.
- Inspect Cron logs for `[railway-cron] Dispatched ...` and API logs for handler failures.
