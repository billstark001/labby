# Labby – Academic Seminar Scheduler

Labby is a seminar scheduling system with a shared algorithm core, a browser UI, and an optional server mode.

The monorepo contains:

- `@labby/core` – scheduling logic plus Rust-powered similarity embedding/projection
- `@labby/web` – Preact UI for data entry, schedule review, and login
- `@labby/server` – Hono API with SQLite storage, auth, solver endpoints, optional email notifications, and scheduled database backups

## Features

- Manage persons, keywords, schedules, and unavailability windows
- Learn keyword similarity from triplet comparisons and persist the generated similarity graph
- Run pair and ranked supervision updates on a 64D embedding, with incremental 2D projection for visualization
- Generate full schedules or incremental re-plans with fairness, pair-diversity, relevance, and churn penalties
- Apply scheduling constraints such as `no-overlap` and `affinity-boost`
- Run in local-browser mode or API-backed server mode
- Authenticate with three roles: `user`, `admin`, and environment-only `root`
- Send schedule reminder emails from cron expressions stored in schedule configs
- Back up the full server database on a cron schedule as either a SQLite snapshot or MsgPack archive
- Deliver backups through email attachments, Google Drive, or OneDrive
- Authenticate the mailer against Gmail through Google OAuth client JSON
- Package the full stack with Docker and `docker-compose`

## Packages

- `packages/core` – scheduling algorithms, domain types, and Rust native/wasm embedding engine
- `packages/web` – Vite app with hash routing, login UI, and API/local storage adapters
- `packages/server` – Hono application, SQLite store, auth service, cron scheduler, mailer, and backup service

## Quick Start

```bash
# Prerequisites: Node >= 20, pnpm >= 10
corepack enable
pnpm install

# Frontend-only development
pnpm --filter @labby/web dev

# Full workspace development
pnpm dev

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
- `POST /api/v1/nlp/recommend-triplet` – request one informative triplet query
- `POST /api/v1/nlp/apply-supervision` – apply pair or ranked supervision query
- `POST /api/v1/nlp/update-similarity` – apply one triplet-learning step and persist updated similarities
- `POST /api/v1/nlp/update-pair` – apply one pair-distance update and persist updated vectors

Read [docs/auth.md](docs/auth.md), [docs/algorithm-scheduling.md](docs/algorithm-scheduling.md), [docs/algorithm-similarity.md](docs/algorithm-similarity.md), and [packages/server/README.md](packages/server/README.md) for details.

## Rust and WASM Build

The similarity engine is implemented in Rust under packages/core/native and exposed through Node addon + WebAssembly bindings.

- local full core build: pnpm --filter @labby/core build
- wasm (web target) only: pnpm --filter @labby/core rust:build:wasm:web
- rust tests: pnpm --filter @labby/core test:rust

In CI deployment workflows, Rust toolchain and wasm-pack are installed on runner and wasm is built during pipeline. Generated wasm artifacts are not committed to git.

## Docker

Labby now ships with a production Docker image and a `docker-compose.yml` example.

```bash
cp .env.example .env
# edit .env and set at least ROOT_PASSWORD and PASETO_SECRET
docker compose up --build
```

The container:

- serves the API on port `4410`
- stores SQLite data in the named volume `labby-data`
- can include the built web app in the image
- enables cron email reminders when SMTP settings are configured
- can run scheduled whole-database backups when backup settings are configured

## Environment

See `.env.example` for all server variables.

Extra examples:

- `.env.backup.example` shows Gmail, email backup, Google Drive, and OneDrive configuration examples.
- `packages/web/.env.frontend-only.example` builds the browser-only deployment.
- `packages/web/.env.server.example` builds the server-connected deployment.

Important settings:

- `PASETO_SECRET` or `PASETO_ACCESS_KEY` + `PASETO_REFRESH_KEY`
- `ROOT_USERNAME`, `ROOT_PASSWORD`, `ROOT_EMAIL`
- `BOOTSTRAP_ADMIN_*` for first-run admin creation
- `SMTP_*` and `NOTIFY_RECIPIENTS` for email reminders
- `SMTP_PROVIDER=gmail`, `GMAIL_*`, `GOOGLE_OAUTH_JSON_PATH`, and `GOOGLE_OAUTH_REFRESH_TOKEN` to use Gmail OAuth instead of raw SMTP credentials
- `BACKUP_*` to schedule whole-database backups
- `GOOGLE_DRIVE_FOLDER_ID` for Google Drive uploads
- `ONEDRIVE_*` for OneDrive uploads
- `DB_PATH` for SQLite storage

## Backup Subsystem

The server can maintain periodic full-database backups through the same cron runtime that powers schedule notifications.

- Set `BACKUP_CRON` to enable backups.
- Choose `BACKUP_FORMAT=sqlite` to emit a SQLite snapshot or `BACKUP_FORMAT=msgpack` to serialize all tables into a MsgPack archive.
- Choose `BACKUP_TARGET=email`, `google-drive`, or `onedrive`.
- Email delivery attaches the generated backup to a normal outbound message.
- Google Drive uses OAuth client credentials loaded from `GOOGLE_OAUTH_JSON_PATH` plus a refresh token.
- OneDrive uses Microsoft OAuth refresh credentials and uploads into `ONEDRIVE_FOLDER`.

## What Changed

- Added a server-side backup subsystem with cron scheduling and pluggable delivery targets.
- Added Gmail OAuth support by reading Google OAuth client credentials from JSON.
- Added whole-database export support for both SQLite snapshot and MsgPack archive formats.

## Deployment

- Static web deployment is still supported with GitHub Pages and Netlify.
- API-backed deployment can use Docker directly or `docker-compose`.
- GitHub Pages and Netlify workflows now force the web app into frontend-only deployment mode.
- Both workflows build Rust wasm artifacts before frontend build.

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
