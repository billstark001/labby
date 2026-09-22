# Railway deployment and Cron

## Architecture

The web/API service uses `railway.json`, a Docker build, PostgreSQL, and Railway's serverless sleep setting. Scheduled work is deliberately a separate, one-shot Railway Cron service. It calls the authenticated internal dispatch endpoint, while the server remains the owner of job names and business logic.

This avoids running `node-cron` in sleeping or horizontally scaled web instances. Use `SCHEDULER_MODE=external` on the web service so jobs are registered for dispatch but not run locally and no Google configuration is required. Set `SCHEDULER_MODE=cron` only when a continuously running single instance is intended. Each Railway Cron service dispatches one registered job by setting `LABBY_CRON_JOB`.

## Server service

1. Create a Railway project, PostgreSQL service, and application service from this repository.
2. Configure `DATABASE_URL`, `DB_DRIVER=postgres`, authentication secrets, `WEB_DIST_DIR=/app/packages/web/dist`, `PUBLIC_BASE_URL`, and `SCHEDULER_DISPATCH_API_KEY`.
3. Deploy with `pnpm deploy:railway`. Use `pnpm deploy:railway:incremental` to skip deployment when the merge-base diff contains no runtime files. `DEPLOY_DIFF_BASE`, `RAILWAY_SERVICE`, `RAILWAY_ENVIRONMENT`, and `RAILWAY_CLI` are optional.
4. Keep at least one API replica available when Cron executes. If serverless sleeping is enabled, the HTTP call wakes it.

## Cron service

Create a service from the same repository and point its config file at `railway.cron.json`. Set:

- `LABBY_SERVER_URL`: public URL of the server service.
- `SCHEDULER_DISPATCH_API_KEY`: the same strong secret as the server.
- `LABBY_CRON_JOB`: an exact registered name, such as `database-backup`, `auth-cleanup`, or `email-task:<id>`.
- `LABBY_CRON_TIMEOUT_MS` (optional): request timeout, default 120000.

Copy the service for each independently scheduled job and change `cronSchedule`. Railway Cron uses UTC and five-field cron expressions. The process exits after one request; `restartPolicyType=NEVER` prevents duplicate retries. A non-2xx response makes the execution fail visibly.

## Operations

- Rotate the dispatch key in the web service and every Cron service together.
- Never expose the key in the repository or command line.
- Inspect Railway deployment logs for `[railway-cron] Dispatched ...` and server logs for job failures.
- Do not schedule the same job both locally and through Railway Cron.
