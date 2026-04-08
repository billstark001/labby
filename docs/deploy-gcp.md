# Deploy Labby Server to GCP (Cloud Run)

This guide is the canonical reference for deploying the API-backed Labby server to Google Cloud Run.

It includes:

- One-time GCP setup
- Repeatable local gcloud deployment flow
- Gmail OAuth secret wiring
- A real deployment archive (Tokyo region, project `labby-scslab`)
- Required running services and rough monthly cost estimate

## Recommended Production Architecture

Use Cloud Run + Cloud SQL (PostgreSQL).

Reason:

- Cloud Run local filesystem is ephemeral, so `sqlite` is not durable.
- The server supports `DB_DRIVER=postgres` + `DATABASE_URL`.

## One-Time GCP Preparation Checklist

1. Enable APIs:
   - Cloud Run API (`run.googleapis.com`)
   - Artifact Registry API (`artifactregistry.googleapis.com`)
   - Cloud Build API (`cloudbuild.googleapis.com`)
   - Secret Manager API (`secretmanager.googleapis.com`)
   - Cloud SQL Admin API (`sqladmin.googleapis.com`) if using PostgreSQL
2. Create Artifact Registry Docker repository in your target region.
3. Prepare runtime service account and permissions.
4. Store runtime secrets in Secret Manager.

## Required Runtime Configuration (Cloud Run)

At minimum:

- `PASETO_SECRET` (or split keys)
- `ROOT_USERNAME`
- `ROOT_PASSWORD`
- `ROOT_EMAIL`
- `DB_DRIVER` (`postgres` recommended)
- `DATABASE_URL` (required when `DB_DRIVER=postgres`)
- `WEB_DIST_DIR=/app/packages/web/dist`

Common optional values:

- `AUTH_ACCESS_TTL`, `AUTH_REFRESH_TTL`
- `SMTP_*`, `NOTIFY_RECIPIENTS`
- `BACKUP_*`
- `SCHEDULER_MODE`, `SCHEDULER_DISPATCH_API_KEY`
- `CLOUD_SCHEDULER_PROJECT_ID`, `CLOUD_SCHEDULER_LOCATION`
- `CLOUD_SCHEDULER_DISPATCH_URL` (optional if `PUBLIC_BASE_URL` is set)
- `CLOUD_SCHEDULER_JOB_PREFIX`

Important for this repository:

- Do not set `PORT` manually in Cloud Run env vars. Cloud Run injects it.
- Set Rust engine paths explicitly at runtime:
  - `LABBY_CORE_NAPI_PATH=/app/packages/core/native/dist/node/labby_core.node`
  - `LABBY_CORE_WASM_NODE_PATH=/app/packages/core/native/dist/wasm-node/labby_core.js`

## Cron + Cloud Scheduler Dual Mode

This server supports three runtime scheduler modes via `SCHEDULER_MODE`:

- `cron`: local node-cron only
- `cloud`: Cloud Scheduler only
- `hybrid`: both local node-cron and Cloud Scheduler

Recommended on Cloud Run: `SCHEDULER_MODE=cloud`.

Implementation notes:

- Internal jobs still register in one place (same `syncJobs()` paths as local mode).
- In `cloud`/`hybrid`, the server mirrors registered internal jobs to Cloud Scheduler automatically.
- Cloud Scheduler triggers `POST /internal/scheduler/dispatch` with `X-Api-Key`.
- The endpoint executes internal jobs by name, so Cloud and local jobs stay in sync without duplicating business logic.

Required env for cloud mirroring:

- `SCHEDULER_DISPATCH_API_KEY=<strong-random-secret>`
- `CLOUD_SCHEDULER_PROJECT_ID=<PROJECT_ID>`
- `CLOUD_SCHEDULER_LOCATION=<REGION>`
- `PUBLIC_BASE_URL=<Cloud Run service URL>` or set `CLOUD_SCHEDULER_DISPATCH_URL` explicitly
- Optional: `CLOUD_SCHEDULER_JOB_PREFIX=labby`

Required IAM for the Cloud Run runtime service account:

- `roles/cloudscheduler.admin` (create/update/delete jobs)

## Gmail OAuth JSON and Token (Secret Manager)

Recommended secure pattern:

1. Keep OAuth client JSON and refresh token JSON in Secret Manager.
2. Mount them as files in Cloud Run.
3. Point env vars to mounted file paths.

Example:

- `GOOGLE_OAUTH_JSON_PATH=/secrets/google-client.json`
- `GOOGLE_OAUTH_REFRESH_TOKEN_PATH=/secrets-token/google-token.json`

Note: mount each secret under a different directory path to avoid Cloud Run mount conflicts.

## Local gcloud CLI Deployment (Repeatable)

### Incremental deployment helper (ts + tsx + pnpm)

Repository root now includes:

```bash
pnpm deploy:cloudrun:incremental
```

Behavior:

- Detects changed files from git merge-base to HEAD.
- Skips deployment when changes only touch non-deployable paths (for example docs only).
- Builds/pushes an amd64 image and deploys Cloud Run when server/core/web/docker-related files changed.

Required env vars:

- `CLOUD_RUN_PROJECT_ID`
- `CLOUD_RUN_REGION`
- `CLOUD_RUN_REPOSITORY`
- `CLOUD_RUN_SERVICE`

Optional env vars:

- `DEPLOY_DIFF_BASE` (override diff base ref)
- `CLOUD_RUN_ENV_VARS_FILE`
- `CLOUD_RUN_UPDATE_SECRETS`
- `CLOUD_RUN_DEPLOY_ARGS`
- `CLOUD_RUN_QUIET` (`false` to disable `--quiet`)

### 1) Select project and configure Docker auth

```bash
gcloud config set project <PROJECT_ID>
gcloud auth configure-docker <REGION>-docker.pkg.dev --quiet
```

### 2) Build and push image (Cloud Run-safe arch)

Use amd64 build from Apple Silicon hosts:

```bash
IMAGE="<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/labby-server:$(date +%Y%m%d-%H%M%S)-amd64"
docker buildx build \
  --platform linux/amd64 \
  --build-arg VITE_DB_CONFIG=api \
  -t "$IMAGE" \
  --push .
```

### 3) Deploy

```bash
gcloud run deploy <SERVICE_NAME> \
  --image "$IMAGE" \
  --region <REGION> \
  --allow-unauthenticated \
  --port 4410 \
  --env-vars-file /tmp/labby-cloudrun-env.yaml \
  --update-secrets "/secrets/google-client.json=labby-google-client-json:latest,/secrets-token/google-token.json=labby-google-token-json:latest"
```

Suggested scheduler-related env entries in `/tmp/labby-cloudrun-env.yaml`:

```yaml
SCHEDULER_MODE: cloud
SCHEDULER_DISPATCH_API_KEY: "<strong-random-secret>"
CLOUD_SCHEDULER_PROJECT_ID: "<PROJECT_ID>"
CLOUD_SCHEDULER_LOCATION: "<REGION>"
CLOUD_SCHEDULER_JOB_PREFIX: "labby"
PUBLIC_BASE_URL: "https://<your-cloud-run-url>"
```

### 4) Check URL

```bash
gcloud run services describe <SERVICE_NAME> --region <REGION> --format='value(status.url)'
```

### 5) Verify mirrored Cloud Scheduler jobs

```bash
gcloud scheduler jobs list \
  --location <REGION> \
  --filter='name~"labby-"' \
  --format='table(name,schedule,timeZone,state)'
```

## Build and Runtime Notes for This Monorepo

The server startup needs Rust native/wasm artifacts from core package at runtime.

Docker image must include all of these:

- `packages/core/dist`
- `packages/core/native/dist`
- `packages/server/dist`
- `packages/web/dist`

If `packages/core/native/dist` is missing, startup fails with Rust engine module not found.

## Troubleshooting (Known Failure Modes)

1. Artifact Registry API disabled:
   - Error: `SERVICE_DISABLED` when listing or pushing repositories.
   - Fix: enable `artifactregistry.googleapis.com`.
2. Cloud Run rejects env `PORT`:
   - Error: reserved env name.
   - Fix: remove `PORT` from user env file.
3. Secret mount conflict:
   - Error: different secrets mounted in same directory.
   - Fix: use separate directories, such as `/secrets/...` and `/secrets-token/...`.
4. Secret access denied:
   - Error: permission denied on secret for runtime service account.
   - Fix: grant `roles/secretmanager.secretAccessor` to Cloud Run runtime service account.
5. Exec format error on startup:
   - Cause: ARM image deployed to Cloud Run.
   - Fix: build and push `linux/amd64` image.
6. Rust engine module not found:
   - Cause: native dist not copied or wrong runtime path.
   - Fix: copy `packages/core/native/dist` into image and set `LABBY_CORE_*` env paths.

## Deployment Archive (Tokyo, 2026-04-07)

This section records what was actually done and verified.

Target:

- Project: `labby-scslab`
- Region: `asia-northeast1` (Tokyo)
- Service: `labby-server`
- Repository: `asia-northeast1-docker.pkg.dev/labby-scslab/labby`

Executed operations summary:

1. Enabled required APIs.
2. Confirmed and used Artifact Registry repository `labby`.
3. Imported existing local OAuth files from `packages/server` into Secret Manager:
   - `labby-google-client-json`
   - `labby-google-token-json`
4. Fixed Docker build chain for this repository (Debian base + Rust/WASM toolchain + native dist copy).
5. Built and pushed amd64 image successfully.
6. Prepared Cloud Run env yaml from existing `packages/server/.env` values.
7. Deployed Cloud Run with secret file mounts and explicit Rust engine paths.
8. Granted `roles/secretmanager.secretAccessor` to runtime account used by Cloud Run.
9. Added scheduler dual-mode runtime (`cron/cloud/hybrid`) and mirrored internal jobs to Cloud Scheduler.
10. Bound internal dispatch endpoint `/internal/scheduler/dispatch` with API-key authentication.

Result:

- Deployment status: success
- Traffic: 100% to latest revision
- Service URL:
  - `https://labby-server-476185329711.asia-northeast1.run.app`
  - `https://labby-server-xj4sdgvwwa-an.a.run.app`

### Scheduler Dual-Mode Rollout Update (Tokyo, 2026-04-07)

Latest rollout for Cloud Scheduler mirroring:

- Latest revision: `labby-server-00012-ngd`
- Image: `asia-northeast1-docker.pkg.dev/labby-scslab/labby/labby-server:20260407-201122-amd64`
- Scheduler mode: `cloud`

Verified after rollout:

1. `/health` returns `{"ok":true,...}` on service URL.
2. Mirrored jobs are enabled in Cloud Scheduler:

- `labby-auth-maintenance-cleanup` (`17 3 * * *`, `UTC`)
- `labby-email-task-nnk1hutze6v-mi5egx68f` (`0 18 * * 5`, `Asia/Tokyo`)

3. Cloud Scheduler callback URI is unified to:

- `https://labby-server-476185329711.asia-northeast1.run.app/internal/scheduler/dispatch`

## Required Running Services and Rough Cost Estimate

To run this deployment in production, at minimum keep these services active:

1. Cloud Run service (`labby-server`)
2. Artifact Registry repository (image storage)
3. Secret Manager secrets (runtime secrets)
4. Cloud SQL PostgreSQL instance (recommended for durable production data)

Optional but common:

1. Cloud Scheduler + backup target (if enabling periodic backup jobs)
2. Cloud Logging and alerting policies

Rough monthly estimate (Tokyo, low-traffic small production):

- Cloud Run:
  - Often very low at light traffic; commonly around USD 5-25/month after free tier depending on requests and CPU/memory settings.
- Artifact Registry:
  - Mostly storage-based; often around USD 1-5/month for a small image set.
- Secret Manager:
  - Usually low, often under USD 1-3/month for a few secrets with low access volume.
- Cloud SQL PostgreSQL (main cost driver):
  - Small always-on instance plus storage is typically around USD 30-120/month depending on tier, HA, backup retention, and I/O.

Practical budget range:

- Minimal production with Cloud SQL: usually around USD 40-150/month.
- Temporary testing without Cloud SQL (not durable): can be much lower.

Always validate with the official GCP Pricing Calculator before final budgeting, because instance class, network egress, and region settings can change actual cost significantly.
