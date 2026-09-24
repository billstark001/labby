# @labby/server

`@labby/server` is the API backend for Labby. It provides authentication, PGlite/Postgres persistence, solver endpoints, ranking-learning endpoints, optional email notifications, and scheduled database backups.

## Responsibilities

- Serve REST endpoints with Hono
- Persist application data in embedded PGlite or external Postgres
- Issue and verify PASETO access and refresh tokens
- Enforce three roles: `user`, `admin`, and `root`
- Run full and incremental scheduling through `@labby/core`
- Run TypeScript embedding joint list supervision with persistent history and persist updated vectors
- Register cron-based email reminders from schedule configs
- Register cron-based whole-database backups to email, Google Drive, or OneDrive
- Optionally serve built frontend static assets (`packages/web/dist`) with SPA fallback

## Roles

- `user` – read-only access to `/api/v1/db/*`
- `admin` – full database writes, solver access, NLP updates, and user creation for regular users
- `root` – configured from environment only, never stored in the database, and allowed to create admin accounts

## Main Routes

### Auth

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

Login returns both tokens in JSON and also writes the refresh token to the `labby_refresh_token` HttpOnly cookie.

### Users

- `POST /api/v1/users` – create a user or admin account
- `GET /api/v1/users` – list stored users without password hashes

### Data

CRUD endpoints exist under `/api/v1/db` for:

- persons
- keywords
- similarities
- configs
- schedules
- unavailabilities

### Solver and NLP

- `POST /api/v1/solver/run`
- `POST /api/v1/solver/run-incremental`





## Request Rules

- All `/api/v1/*` requests must include `X-Request-Id`.
- Authenticated routes require `Authorization: Bearer <access_token>`.
- Non-GET `/api/v1/db/*` routes require at least `admin`.
- All solver and NLP routes require at least `admin`.

## Environment

Copy `.env.example` to `.env` and fill in the required values.

Local `dev` and `start:local` commands load `.env` followed by optional `.env.local` through
Node's native env-file flags. Shell variables take precedence. `--env-file-if-exists` requires
Node 22.9 or newer; this repository requires Node 24 or newer. The production `start` command
does not load dotenv files and consumes only its injected process environment.

Database maintenance package scripts execute their programs through `env-lane run server`. The
default `local` build loads `.env`, optional `.env.local`, and then the shell; set
`ENV_BUILD=BUILD` to select another configured package-local layer. `auth:gmail` loads only
`packages/server/.env`. See
[`docs/environment-files.md`](../../docs/environment-files.md) for the complete command matrix.

Required or important settings:

- `PORT`
- `PGLITE_DATA_DIR`
- `PASETO_SECRET` or separate access/refresh keys
- `ROOT_PASSWORD`
- `WEB_DIST_DIR` (optional, for serving built frontend static files in server mode)

Optional settings:

- `AUTH_ACCESS_TTL`, `AUTH_REFRESH_TTL`
- `SMTP_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- `GMAIL_USER`, `GMAIL_REFRESH_TOKEN`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_JSON_PATH`
- `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_OAUTH_REFRESH_TOKEN_PATH`
- `NOTIFY_RECIPIENTS`
- `PUBLIC_BASE_URL`
- `SCHEDULER_MODE`, `SCHEDULER_DISPATCH_API_KEY`
- `CLOUD_SCHEDULER_PROJECT_ID`, `CLOUD_SCHEDULER_LOCATION`, `CLOUD_SCHEDULER_DISPATCH_URL`, `CLOUD_SCHEDULER_JOB_PREFIX`
- `BACKUP_CRON`, `BACKUP_TIMEZONE`, `BACKUP_FORMAT`, `BACKUP_TARGET`, `BACKUP_FILENAME_PREFIX`
- `BACKUP_EMAIL_RECIPIENTS`, `GOOGLE_DRIVE_FOLDER_ID`
- `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`, `ONEDRIVE_REFRESH_TOKEN`, `ONEDRIVE_TENANT_ID`, `ONEDRIVE_FOLDER`

## Development

```bash
# Explicit setup for a new database (path is relative to packages/server):
pnpm --filter @labby/server db:init --pglite ./run/labby-pg
# Existing databases instead require db:migrate --action up with their explicit target.
pnpm --filter @labby/server dev
```

## Build

```bash
pnpm --filter @labby/core build
pnpm --filter @labby/server build
pnpm --filter @labby/server start
```

Build `@labby/core` first when compiling the server package in isolation.

## Email Notifications

When SMTP is configured, the server starts the cron subsystem on boot.

- Each schedule config can define `notifyAt` and `notifyTimezone`.
- The notifier finds the latest generated plan for that config.
- The server sends a short reminder email to `NOTIFY_RECIPIENTS`.

If SMTP is not configured, the cron subsystem stays disabled.

## Scheduler Modes

The scheduler can run in four modes using `SCHEDULER_MODE`:

- `cron`: local node-cron only
- `external` (alias `railway`): register dispatchable jobs without local timers or a provider mirror
- `cloud`: Cloud Scheduler only
- `hybrid`: local cron + Cloud Scheduler mirrored jobs

In `cloud`/`hybrid`, the server keeps Cloud Scheduler jobs synchronized with internal job registration and uses `POST /internal/scheduler/dispatch` + `SCHEDULER_DISPATCH_API_KEY` for secure execution.

Current limitation: mirrored scheduler dispatch assumes a single live server instance. Job definitions are held in memory, so multi-instance Cloud Run deployments can route a callback to an instance that has not synced the latest job set.

Each email task can opt in via metadata (`serveScheduleIcs`) to expose its latest schedule at:

- `GET /public/email-tasks/:taskId/schedule.ics`

Meeting times, email dispatch times, defaults, and ICS UTC conversion are defined in [the timezone rules](../../docs/timezone-semantics.md).

## Backup Subsystem

When `BACKUP_CRON` is configured, the server registers a recurring whole-database backup job.

- `BACKUP_FORMAT=msgpack` serializes every application table into a `.msgpack` archive.
- `BACKUP_TARGET=email` sends the archive as a mail attachment.
- `BACKUP_TARGET=google-drive` uploads to Google Drive using OAuth credentials loaded from `GOOGLE_OAUTH_JSON_PATH`.
- `BACKUP_TARGET=onedrive` uploads to OneDrive using Microsoft OAuth refresh credentials.

Gmail delivery can reuse the same Google OAuth client JSON. Set `SMTP_PROVIDER=gmail-api` to send through the Gmail HTTPS API, or `SMTP_PROVIDER=gmail` to use Gmail SMTP. The API mode has a 60-second timeout covering token exchange and the Gmail request. Gmail API mode supports text, HTML, and attachments through the existing mailer interface.

At runtime, direct `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` values take precedence
over `GOOGLE_OAUTH_JSON_PATH`. Gmail uses `GMAIL_REFRESH_TOKEN` first, followed by
`GOOGLE_OAUTH_REFRESH_TOKEN` and then `GOOGLE_OAUTH_REFRESH_TOKEN_PATH`. Google Drive uses the
shared token value followed by the same token-file fallback. Direct client variables must always be
configured together.

For container/server deployment:

- Docker: mount OAuth JSON/token files read-only and set `GOOGLE_OAUTH_JSON_PATH` / `GOOGLE_OAUTH_REFRESH_TOKEN_PATH` to mounted paths.
- GCP Cloud Run: prefer Secret Manager; mount OAuth JSON as files and bind refresh token via file or env secret.

See `docs/deploy-gcp.md` for concrete CLI examples.

## Embedding Runtime Notes

- Server boot hydrates the shared TypeScript embedding runtime from stored vectors.
- Ranking updates atomically persist active product-space coordinates and accepted history. See [algorithm](../../docs/algorithm-similarity.md) and [migrations](../../docs/database-migrations.md).
- Persisted updates are written back to keyword vector storage in batch.
