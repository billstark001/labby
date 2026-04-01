# @labby/server

`@labby/server` is the API backend for Labby. It provides authentication, SQLite persistence, solver endpoints, triplet-learning endpoints, and optional email notifications.

## Responsibilities

- Serve REST endpoints with Hono
- Persist application data in SQLite via `better-sqlite3`
- Issue and verify PASETO access and refresh tokens
- Enforce three roles: `user`, `admin`, and `root`
- Run full and incremental scheduling through `@labby/core`
- Update keyword similarities from triplet feedback
- Register cron-based email reminders from schedule configs

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
- `POST /api/v1/nlp/update-similarity`

## Request Rules

- All `/api/v1/*` requests must include `X-Request-Id`.
- Authenticated routes require `Authorization: Bearer <access_token>`.
- Non-GET `/api/v1/db/*` routes require at least `admin`.
- All solver and NLP routes require at least `admin`.

## Environment

Copy `.env.example` to `.env` and fill in the required values.

Required or important settings:

- `PORT`
- `DB_PATH`
- `PASETO_SECRET` or separate access/refresh keys
- `ROOT_PASSWORD`
- `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_EMAIL`

Optional settings:

- `AUTH_ACCESS_TTL`, `AUTH_REFRESH_TTL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- `NOTIFY_RECIPIENTS`

## Development

```bash
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
