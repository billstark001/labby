# Labby – Academic Seminar Scheduler

Labby is a seminar scheduling system with a shared algorithm core, a browser UI, and an optional server mode.

The monorepo contains:

- `@labby/core` – scheduling and keyword-similarity logic
- `@labby/web` – Preact UI for data entry, schedule review, and login
- `@labby/server` – Hono API with SQLite storage, auth, solver endpoints, and optional email notifications

## Features

- Manage persons, keywords, schedules, and unavailability windows
- Learn keyword similarity from triplet comparisons and persist the generated similarity graph
- Generate full schedules or incremental re-plans with fairness, pair-diversity, relevance, and churn penalties
- Apply scheduling constraints such as `no-overlap` and `affinity-boost`
- Run in local-browser mode or API-backed server mode
- Authenticate with three roles: `user`, `admin`, and environment-only `root`
- Send schedule reminder emails from cron expressions stored in schedule configs
- Package the full stack with Docker and `docker-compose`

## Packages

- `packages/core` – pure TypeScript algorithms and domain types
- `packages/web` – Vite app with hash routing, login UI, and API/local storage adapters
- `packages/server` – Hono application, SQLite store, auth service, cron scheduler, and mailer

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
- `POST /api/v1/nlp/update-similarity` – apply one triplet-learning step and persist updated similarities

Read [docs/auth.md](docs/auth.md), [docs/algorithm.md](docs/algorithm.md), and [packages/server/README.md](packages/server/README.md) for details.

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

## Environment

See `.env.example` for all server variables.

Important settings:

- `PASETO_SECRET` or `PASETO_ACCESS_KEY` + `PASETO_REFRESH_KEY`
- `ROOT_USERNAME`, `ROOT_PASSWORD`, `ROOT_EMAIL`
- `BOOTSTRAP_ADMIN_*` for first-run admin creation
- `SMTP_*` and `NOTIFY_RECIPIENTS` for email reminders
- `DB_PATH` for SQLite storage

## Deployment

- Static web deployment is still supported with GitHub Pages and Netlify.
- API-backed deployment can use Docker directly or `docker-compose`.

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
