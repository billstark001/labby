# Labby – Academic Seminar Scheduler

Labby is a seminar scheduling system with a shared algorithm core, a browser UI, and an optional server mode.

The monorepo contains:

- `@labby/core` – scheduling logic plus portable TypeScript similarity embedding/projection
- `@labby/web` – Preact UI for data entry, schedule review, and login
- `@labby/server` – Hono API with PGlite/Postgres storage, auth, solver endpoints, optional email notifications, and scheduled database backups

## Features

- Manage persons, keywords, schedules, and unavailability windows
- Learn keyword similarity from active list rankings, including ties and uncertain judgments
- Jointly train a 16-dimensional hyperbolic–Euclidean product embedding with persistent history protection
- Generate full schedules or incremental re-plans with fairness, pair-diversity, relevance, and churn penalties
- Apply scheduling constraints such as `no-overlap` and `affinity-boost`
- Run in local-browser mode or API-backed server mode
- Authenticate with three roles: `user`, `admin`, and environment-only `root`
- Send schedule reminder emails from cron expressions stored in schedule configs
- Back up the full server database on a cron schedule as a MsgPack archive
- Deliver backups through email attachments, Google Drive, or OneDrive
- Authenticate the mailer against Gmail through Google OAuth client JSON
- Package the full stack with Docker and `docker-compose`

## Packages

- `packages/core` – scheduling algorithms, domain types, and the shared TypeScript embedding engine
- `packages/web` – Vite app with hash routing, login UI, and API/local storage adapters
- `packages/db` – shared PostgreSQL/PGlite schema, graph queries, and business record SQL
- `packages/server` – Hono application, PGlite/Postgres store, auth service, cron scheduler, mailer, and backup service

## Quick Start

```bash
# Prerequisites: Node >= 24, pnpm 12.x
corepack enable
pnpm install

# Frontend-only development
pnpm --filter @labby/web dev

# API-backed development. Initialize the server database before the first run:
pnpm --filter @labby/server db:init --pglite ./run/labby-pg
# Run these in separate terminals:
pnpm dev:server
pnpm dev:server:web

# Production build
pnpm build
```

## Server Mode

The server exposes authenticated REST endpoints under `/api/v1`.

- `POST /api/v1/auth/login` – issue access and refresh tokens
- `POST /api/v1/auth/refresh` – rotate refresh tokens
- `POST /api/v1/auth/logout` – revoke the current session
- `GET /api/v1/auth/me` – inspect the current session
- `GET/PUT/DELETE /api/v1/db/...` – CRUD for persons, keywords, similarities, configs, schedules, and unavailabilities
- `POST /api/v1/solver/run` – generate a full schedule
- `POST /api/v1/solver/run-incremental` – re-plan from a change date

Read [docs/auth.md](docs/auth.md), [docs/algorithm-scheduling.md](docs/algorithm-scheduling.md), [docs/algorithm-similarity.md](docs/algorithm-similarity.md), and [packages/server/README.md](packages/server/README.md) for details.

## Embedding Runtime

Similarity APIs: `POST /api/v1/nlp/recommend-ranking`, `POST /api/v1/nlp/train-ranking`, and `GET /api/v1/nlp/history`. See [algorithm](docs/algorithm-similarity.md), [dimension experiments](docs/dimension-benchmark.md), and [migrations](docs/database-migrations.md).

The similarity engine is a shared TypeScript implementation in `@labby/core`, so normal builds require only Node.js and pnpm.

## Docker

Labby now ships with a production Docker image and a `docker-compose.yml` example.

```bash
cp packages/server/.env.example packages/server/.env
# edit packages/server/.env and set at least ROOT_PASSWORD and PASETO_SECRET
pnpm docker:up
```

The container:

- serves the API on port `4410`
- stores PGlite data in the named volume `labby-data`
- can include the built web app in the image
- enables cron email reminders when SMTP settings are configured
- can run scheduled whole-database backups when backup settings are configured

## Environment

See [docs/environment-files.md](docs/environment-files.md) for the exact file and precedence used by
each command. Server, database, Docker, and deployment commands use env files under
`packages/server`; project commands do not load a repository-root `.env`.

Extra examples:

- `packages/web/.env.frontend-only.example` documents the browser-only values.
- `packages/web/.env.server.example` documents the server-connected values.

Those web examples are not loaded automatically; the checked-in `dev:*` and `build:*` scripts set
the corresponding values explicitly. Use Vite's conventional `.env.development*` or
`.env.production*` files for additional web variables.

Important settings:

- `PASETO_SECRET` or `PASETO_ACCESS_KEY` + `PASETO_REFRESH_KEY`
- `ROOT_USERNAME`, `ROOT_PASSWORD`, `ROOT_EMAIL`
- `SMTP_*` and `NOTIFY_RECIPIENTS` for email reminders
- `SMTP_PROVIDER=gmail`, `GMAIL_*`, and Google OAuth credentials to use Gmail OAuth instead of raw SMTP credentials. Runtime client credentials prefer `GOOGLE_OAUTH_CLIENT_ID` plus `GOOGLE_OAUTH_CLIENT_SECRET`, then fall back to `GOOGLE_OAUTH_JSON_PATH`. Gmail refresh tokens prefer `GMAIL_REFRESH_TOKEN`, then `GOOGLE_OAUTH_REFRESH_TOKEN`, then `GOOGLE_OAUTH_REFRESH_TOKEN_PATH`.
- `BACKUP_*` to schedule whole-database backups
- `GOOGLE_DRIVE_FOLDER_ID` for Google Drive uploads
- `ONEDRIVE_*` for OneDrive uploads
- `PGLITE_DATA_DIR` for embedded Postgres storage
- `WEB_DIST_DIR` to let server mode serve `packages/web/dist` static files

## Backup Subsystem

The server can maintain periodic full-database backups through the same cron runtime that powers schedule notifications.

- Set `BACKUP_CRON` to enable backups.
- Backups use MsgPack to serialize all tables into a portable archive.
- Choose `BACKUP_TARGET=email`, `google-drive`, or `onedrive`.
- Email delivery attaches the generated backup to a normal outbound message.
- Google Drive uses OAuth client credentials loaded from `GOOGLE_OAUTH_JSON_PATH` plus a refresh token.
- OneDrive uses Microsoft OAuth refresh credentials and uploads into `ONEDRIVE_FOLDER`.

## What Changed

- Added a server-side backup subsystem with cron scheduling and pluggable delivery targets.
- Added Gmail OAuth support by reading Google OAuth client credentials from JSON.
- Added whole-database export support through the MsgPack archive format.

## Deployment

- Static web deployment is still supported with GitHub Pages and Netlify.
- API-backed deployment can use Docker directly or `docker-compose`.
- GitHub Pages and Netlify workflows now force the web app into frontend-only deployment mode.
- Both workflows build the frontend directly with the shared TypeScript embedding engine.
- GCP server deployment guidance and Cloud Run workflow are documented in `docs/deploy-gcp.md`.
- Railway serverless and Cron deployment is documented in `docs/deploy-railway.md`; shared UI, loading, scheduling, and deployment rules are in `docs/engineering-standards.md`.
- Cloud Scheduler mirroring currently assumes a single live server instance because dispatch looks up in-memory registered jobs. Keep Cloud Run at one instance for scheduler-backed deployments until this is externalized.

## Project Structure

```text
labby/
├── docs/
├── Dockerfile
├── docker-compose.yml
├── package.json
└── packages/
  ├── core/
  ├── server/
  └── web/
```
