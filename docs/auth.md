# Frontend Auth State Management

This document describes the current web authentication flow used in API-backed mode.

## Overview

Labby uses short-lived PASETO access tokens and rotating refresh tokens.

- Access tokens are sent in the `Authorization` header.
- Refresh tokens are returned in the JSON response.
- The server also writes the refresh token to the `labby_refresh_token` HttpOnly cookie.
- The web client keeps the active session in signals and rehydrates it from local storage after reload.

## Roles

The backend supports three roles:

- `user`
- `admin`
- `root`

`root` is configured from environment variables only and is never stored in SQLite.

## Endpoints

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

All `/api/v1/*` requests must include `X-Request-Id`.

## Login

The login screen collects a username-or-email value and a password.

Example request:

```json
POST /api/v1/auth/login
{
  "email": "admin@example.com",
  "password": "secret"
}
```

Successful response:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer"
}
```

The client stores the returned tokens, schedules the next silent refresh, and updates other tabs through `BroadcastChannel`.

## Token Storage

The current implementation uses two layers:

- in-memory signals for the active runtime session
- local storage for session rehydration after page reload

Stored data is keyed by a normalized session identity and includes the latest access token, refresh token, and update time.

The server-managed refresh cookie exists in parallel, but the current web client still sends `refresh_token` explicitly in the request body.

## Authenticated Requests

Every authenticated API call attaches the current access token:

```text
Authorization: Bearer <access_token>
```

The client wrapper also injects `X-Request-Id` automatically.

## Refresh Flow

Access tokens are refreshed in two cases:

- proactively on a fixed 12-minute timer
- reactively after a `401` response

Refresh request:

```json
POST /api/v1/auth/refresh
{
  "refresh_token": "<refresh_token>"
}
```

The server rotates refresh tokens. After every successful refresh, the client must replace both tokens immediately.

If refresh fails with `401`, the session is invalidated, stored session data is cleared, and the UI returns to login.

## Cross-Tab Behaviour

The web client uses `BroadcastChannel('labby_auth')` to synchronize:

- new tokens
- logout events
- refresh invalidation events

This prevents stale tabs from continuing to use revoked refresh tokens after another tab logs out or refreshes first.

## Logout

Logout calls:

```text
POST /api/v1/auth/logout
Authorization: Bearer <access_token>
```

The server revokes refresh tokens for the current user and clears the refresh cookie. The client then removes local session state and broadcasts the logout event to other tabs.
