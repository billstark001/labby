# Deploy Labby Server to GCP (Cloud Run)

This guide describes the minimum setup for API-backed server deployment on Google Cloud Platform.

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
