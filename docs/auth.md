# Frontend Auth State Management

---

## Token Storage

Store tokens in memory only (JavaScript variables / signals). Never in `localStorage` or `sessionStorage`.

For long-lived sessions, store the **refresh token** in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie set by the server, so it survives page reloads without being accessible to JavaScript.

---

## Endpoint Summary

Login endpoint: `POST /api/v1/auth/login`
Refresh endpoint: `POST /api/v1/auth/refresh`
Token `sub` claim: `user` or `admin`
Protected routes: `/api/v1/...`

---

## Attaching Tokens to Requests

Every authenticated request must include the access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

There is no cookie-based access token. The access token lives only in memory.

---

## Token Refresh Flow (Rotation)

Access tokens expire in 15 minutes. Before expiry (or on receiving `401`), call the refresh endpoint:

```
POST /api/v1/auth/refresh
Content-Type: application/json

{ "refresh_token": "<refresh_token>" }
```

Response (both):

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer"
}
```

**Important:** Each refresh call invalidates the old refresh token and issues a new one. Replace both tokens immediately. If another tab already refreshed, the older token will be rejected — handle this by redirecting to login.

---

## Proactive Refresh

PASETO v4 local tokens are symmetrically encrypted — the payload **cannot be decoded on the client** without the server key. Use a fixed-interval refresh instead (12 minutes for a 15-minute access TTL):

```ts
// pseudo-code — schedule a refresh 12 minutes after login/last refresh
const REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const timer = setTimeout(doSilentRefresh, REFRESH_INTERVAL_MS);
```

On `401 Unauthorized` from any endpoint, attempt one silent refresh then retry. If the refresh also fails, clear tokens and redirect to login.

---

## Logout

```
POST /api/v1/auth/logout
Authorization: Bearer <access_token>
```

On success: clear both tokens from memory (and the cookie if used), cancel any scheduled refresh timers, redirect to login.

---

## Concurrent-Tab Safety

Use a `BroadcastChannel` (or `storage` event as fallback) to synchronize token state across tabs:

```ts
const channel = new BroadcastChannel('auth');
channel.postMessage({ type: 'tokens', accessToken, refreshToken });
channel.onmessage = (e) => {
  if (e.data.type === 'tokens') replaceTokens(e.data);
  if (e.data.type === 'logout') clearAndRedirect();
};
```
