# Deploy Labby Server to GCP (Cloud Run)

This guide describes the minimum setup for API-backed server deployment on Google Cloud Platform.

## Can I Deploy Directly with Local gcloud CLI?

Yes. You can deploy from your local machine without GitHub Actions.

Example (build + push + deploy):

```bash
# 1) Login and select project
gcloud auth login
gcloud config set project <PROJECT_ID>

# 2) Configure Artifact Registry Docker auth
gcloud auth configure-docker <REGION>-docker.pkg.dev --quiet

# 3) Build and push image
IMAGE="<REGION>-docker.pkg.dev/<PROJECT_ID>/<REPOSITORY>/labby-server:$(date +%Y%m%d-%H%M%S)"
docker build --build-arg VITE_DB_CONFIG=api -t "$IMAGE" .
docker push "$IMAGE"

# 4) Deploy to Cloud Run
gcloud run deploy <SERVICE_NAME> \
   --image "$IMAGE" \
   --region <REGION> \
   --platform managed \
   --allow-unauthenticated \
   --port 4410 \
   --set-env-vars "NODE_ENV=production,PORT=4410,DB_DRIVER=postgres,WEB_DIST_DIR=/app/packages/web/dist"
```

Then set additional required env/secrets (for example `DATABASE_URL`, `PASETO_SECRET`, `ROOT_PASSWORD`) using Cloud Run env vars or Secret Manager bindings.

## What Was Missing and What Is Added

- Manual Cloud Run deployment workflow is added: `.github/workflows/deploy-gcp-cloud-run.yml`.
- Server-side static frontend serving is now supported when `WEB_DIST_DIR` points to built web assets.
- Runtime prerequisites are documented below (secrets, DB mode, and storage caveats).

## Recommended Architecture

Use Cloud Run + Cloud SQL (PostgreSQL) for production.

Why:

- Cloud Run local filesystem is ephemeral, so `sqlite` is not durable for production.
- The server already supports `DB_DRIVER=postgres` and `DATABASE_URL`.

## Required GitHub Secrets (for workflow)

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

These are used by `google-github-actions/auth` for workload identity federation.

## Required Runtime Configuration (Cloud Run service)

At minimum, configure:

- `PASETO_SECRET` (or separate `PASETO_ACCESS_KEY` + `PASETO_REFRESH_KEY`)
- `ROOT_USERNAME`
- `ROOT_PASSWORD`
- `ROOT_EMAIL`
- `DB_DRIVER` (`postgres` recommended)
- `DATABASE_URL` (required when `DB_DRIVER=postgres`)
- `WEB_DIST_DIR=/app/packages/web/dist`

Optional but common:

- `AUTH_ACCESS_TTL`, `AUTH_REFRESH_TTL`
- `SMTP_*` and `NOTIFY_RECIPIENTS`
- `BACKUP_*`

## Gmail OAuth JSON: How to Obtain It

Labby server expects a Google OAuth client JSON file and a Gmail refresh token.

1. Create OAuth client in Google Cloud Console:
   - APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
   - Application type: Desktop app (or Web app if you manage redirect URI yourself)
2. Download the OAuth client JSON file.
3. Generate refresh token with Labby script (scope must include `https://mail.google.com/`):

```bash
# from repository root
export GOOGLE_OAUTH_JSON_PATH=packages/server/google-client.json
export GOOGLE_OAUTH_REFRESH_TOKEN_PATH=packages/server/google-token.json
pnpm --filter @labby/server auth:gmail
```

4. Use either:
   - `GMAIL_REFRESH_TOKEN` / `GOOGLE_OAUTH_REFRESH_TOKEN` as raw env string, or
   - `GOOGLE_OAUTH_REFRESH_TOKEN_PATH` to point to the token JSON file.

## Docker: Supplying Gmail OAuth JSON and Token

Current `docker-compose.yml` already passes these env vars through:

- `SMTP_PROVIDER`
- `GMAIL_USER`
- `GMAIL_REFRESH_TOKEN`
- `GOOGLE_OAUTH_JSON_PATH`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_OAUTH_REFRESH_TOKEN_PATH`

Recommended secure pattern for Docker:

1. Mount secret files read-only (example path `/run/secrets`).
2. Set:
   - `SMTP_PROVIDER=gmail`
   - `GMAIL_USER=<gmail-address>`
   - `GOOGLE_OAUTH_JSON_PATH=/run/secrets/google-client.json`
   - `GOOGLE_OAUTH_REFRESH_TOKEN_PATH=/run/secrets/google-token.json`

Example compose snippet:

```yaml
services:
  server:
    volumes:
      - ./secrets/google-client.json:/run/secrets/google-client.json:ro
      - ./secrets/google-token.json:/run/secrets/google-token.json:ro
    environment:
      SMTP_PROVIDER: gmail
      GMAIL_USER: your-account@gmail.com
      GOOGLE_OAUTH_JSON_PATH: /run/secrets/google-client.json
      GOOGLE_OAUTH_REFRESH_TOKEN_PATH: /run/secrets/google-token.json
```

## Cloud Run: Supplying Gmail OAuth JSON and Token

Recommended secure pattern on GCP:

1. Store secrets in Secret Manager:
   - OAuth client JSON secret (for example `labby-google-client-json`)
   - refresh token JSON secret (for example `labby-google-token-json`) or raw token secret
2. Mount JSON secrets as files to Cloud Run and point env vars to mounted paths.

Example deploy flags (file-mount style):

```bash
gcloud run deploy <SERVICE_NAME> \
  --image "$IMAGE" \
  --region <REGION> \
  --set-env-vars "SMTP_PROVIDER=gmail,GMAIL_USER=<gmail>,GOOGLE_OAUTH_JSON_PATH=/secrets/google-client.json,GOOGLE_OAUTH_REFRESH_TOKEN_PATH=/secrets/google-token.json" \
  --update-secrets "/secrets/google-client.json=labby-google-client-json:latest,/secrets/google-token.json=labby-google-token-json:latest"
```

Alternative (env-value style for refresh token only):

- Keep client JSON as mounted file.
- Inject `GMAIL_REFRESH_TOKEN` from Secret Manager env binding.

## Manual Deploy via GitHub Actions

Run workflow `.github/workflows/deploy-gcp-cloud-run.yml` manually and provide:

- `project_id`
- `region`
- `service`
- `repository`
- `db_driver`

Workflow behavior:

1. Build Docker image from repository root.
2. Push image to Artifact Registry.
3. Deploy image to Cloud Run.
4. Print deployed service URL.

## One-Time GCP Preparation Checklist

1. Enable APIs:
   - Cloud Run API
   - Artifact Registry API
   - IAM Credentials API
   - Cloud SQL Admin API (if using postgres)
2. Create Artifact Registry repository.
3. Create Cloud Run service account with required permissions:
   - `roles/run.admin`
   - `roles/artifactregistry.writer`
   - `roles/iam.serviceAccountUser`
4. Configure workload identity federation for GitHub repository.
5. Store runtime secrets in Secret Manager and bind them to Cloud Run.

## Notes for SQLite Mode

`DB_DRIVER=sqlite` can run on Cloud Run only for temporary/testing usage because local files are not persistent between instance restarts.

For stable server mode in production, use PostgreSQL.
