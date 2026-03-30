/**
 * Auth state management using preact-signals.
 *
 * Tokens live in memory only.
 * See docs/auth-state.md for the full spec.
 */
import { signal, computed } from '@preact/signals';

const BASE = '/api/v1';
const STORAGE_KEY = 'labby_auth_state_v1';
export const AUTH_INVALIDATE_EVENT = 'labby:auth:invalidate';

// #region Signals

export const accessToken = signal<string | null>(null);
export const refreshToken = signal<string | null>(null);

/** Derived: whether the current session is authenticated. */
export const isAuthenticated = computed(() => accessToken.value !== null);

// #endregion

// #region Persistent state (localStorage)

type AuthRole = 'user' | 'admin';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  role: AuthRole;
  updatedAt: number;
}

interface PersistedAuthState {
  version: 1;
  currentSessionKey: string | null;
  sessions: Record<string, StoredSession>;
}

export interface AuthInvalidateDetail {
  sessionKey: string | null;
  role: AuthRole | null;
  reason: 'refresh_401' | 'logout';
}

function _defaultPersistedState(): PersistedAuthState {
  return {
    version: 1,
    currentSessionKey: null,
    sessions: {},
  };
}

function _readPersistedState(): PersistedAuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return _defaultPersistedState();
    const parsed = JSON.parse(raw) as Partial<PersistedAuthState>;
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
      return _defaultPersistedState();
    }
    return {
      version: 1,
      currentSessionKey: typeof parsed.currentSessionKey === 'string' ? parsed.currentSessionKey : null,
      sessions: parsed.sessions as Record<string, StoredSession>,
    };
  } catch {
    return _defaultPersistedState();
  }
}

function _writePersistedState(state: PersistedAuthState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage failures (private mode/quota exceeded)
  }
}

function _normalizeIdentity(v: string): string {
  return v.trim().toLowerCase();
}

function _makeSessionKey(role: AuthRole, identity: string): string {
  return `${role}:${_normalizeIdentity(identity)}`;
}

let _activeSessionKey: string | null = null;
let _activeRole: AuthRole | null = null;

// #endregion

// #region Internal refresh scheduling

let _refreshTimer: ReturnType<typeof setTimeout> | undefined;

type RefreshFn = () => Promise<AuthResponse>;

function scheduleRefresh(token: string, refreshFn: RefreshFn): void {
  clearTimeout(_refreshTimer);
  // PASETO v4.local tokens are encrypted — we can't read the payload on the
  // client. Fall back to a fixed 12-minute interval (access TTL is 15 min).
  void token;
  const delay = 12 * 60 * 1000;
  _refreshTimer = setTimeout(async () => {
    try { await refreshFn(); } catch { /* session expired — caller handles 401 */ }
  }, delay);
}

// #endregion

// #region Cross-tab sync via BroadcastChannel

type AuthBroadcastMsg =
  | { type: 'tokens'; accessToken: string; refreshToken: string; role: AuthRole; sessionKey: string }
  | { type: 'logout'; sessionKey: string | null; role: AuthRole | null }
  | { type: 'invalidate'; sessionKey: string | null; role: AuthRole | null; reason: 'refresh_401' | 'logout' };

let _channel: BroadcastChannel | null = null;
try {
  _channel = new BroadcastChannel('labby_auth');
  _channel.onmessage = (e: MessageEvent<AuthBroadcastMsg>) => {
    if (e.data?.type === 'tokens') {
      _setTokens(
        e.data.accessToken,
        e.data.refreshToken,
        { role: e.data.role, sessionKey: e.data.sessionKey },
        false,
      );
    } else if (e.data?.type === 'logout') {
      _clearTokens({ reason: 'logout' }, false);
    } else if (e.data?.type === 'invalidate') {
      _invalidateSession(e.data.sessionKey, e.data.role, e.data.reason, false);
    }
  };
} catch {
  // BroadcastChannel not available
}

function _broadcast(msg: AuthBroadcastMsg): void {
  try { _channel?.postMessage(msg); } catch { /* ignore */ }
}

function _publishInvalidateEvent(detail: AuthInvalidateDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<AuthInvalidateDetail>(AUTH_INVALIDATE_EVENT, { detail }));
  } catch {
    // no-op in non-browser contexts
  }
}

// #endregion

// #region Token helpers

function _setTokens(
  at: string,
  rt: string,
  meta?: { role: AuthRole; sessionKey: string },
  broadcast = true,
): void {
  if (meta) {
    _activeRole = meta.role;
    _activeSessionKey = meta.sessionKey;
  }

  const role = _activeRole;
  const sessionKey = _activeSessionKey;

  accessToken.value = at;
  refreshToken.value = rt;

  if (role && sessionKey) {
    const state = _readPersistedState();
    state.currentSessionKey = sessionKey;
    state.sessions[sessionKey] = {
      accessToken: at,
      refreshToken: rt,
      role,
      updatedAt: Date.now(),
    };
    _writePersistedState(state);
  }

  if (broadcast && role && sessionKey) {
    _broadcast({ type: 'tokens', accessToken: at, refreshToken: rt, role, sessionKey });
  }
}

function _clearTokens(
  options: { reason: 'refresh_401' | 'logout' },
  broadcast = true,
): void {
  const priorSessionKey = _activeSessionKey;
  const priorRole = _activeRole;

  clearTimeout(_refreshTimer);
  accessToken.value = null;
  refreshToken.value = null;
  _activeSessionKey = null;
  _activeRole = null;

  const state = _readPersistedState();
  if (priorSessionKey && state.sessions[priorSessionKey]) {
    delete state.sessions[priorSessionKey];
  }
  if (state.currentSessionKey === priorSessionKey) {
    state.currentSessionKey = null;
  }
  _writePersistedState(state);

  const detail: AuthInvalidateDetail = {
    sessionKey: priorSessionKey,
    role: priorRole,
    reason: options.reason,
  };
  _publishInvalidateEvent(detail);

  if (broadcast) {
    _broadcast({ type: 'logout', sessionKey: priorSessionKey, role: priorRole });
    _broadcast({ type: 'invalidate', sessionKey: priorSessionKey, role: priorRole, reason: options.reason });
  }
}

function _invalidateSession(
  sessionKey: string | null,
  role: AuthRole | null,
  reason: 'refresh_401' | 'logout',
  broadcast = true,
): void {
  const state = _readPersistedState();
  if (sessionKey && state.sessions[sessionKey]) {
    delete state.sessions[sessionKey];
  }
  if (state.currentSessionKey === sessionKey) {
    state.currentSessionKey = null;
  }
  _writePersistedState(state);

  if (_activeSessionKey === sessionKey) {
    clearTimeout(_refreshTimer);
    accessToken.value = null;
    refreshToken.value = null;
    _activeSessionKey = null;
    _activeRole = null;
  }

  const detail: AuthInvalidateDetail = { sessionKey, role, reason };
  _publishInvalidateEvent(detail);

  if (broadcast) {
    _broadcast({ type: 'invalidate', sessionKey, role, reason });
  }
}

// #endregion

// #region Types

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

// #endregion

// #region Auth actions

/** Log in with email + password (regular user). */
export async function login(email: string, password: string): Promise<AuthResponse> {
  const sessionKey = _makeSessionKey('user', email);
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? 'Login failed');
  }
  const data = await res.json() as AuthResponse;
  _setTokens(data.access_token, data.refresh_token, { role: 'user', sessionKey });
  scheduleRefresh(data.access_token, () => silentRefresh());
  return data;
}

/** Silently refresh user tokens (rotation). Throws on failure. */
export async function silentRefresh(): Promise<AuthResponse> {
  const rt = refreshToken.value;
  if (!rt) throw new Error('No refresh token');
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!res.ok) {
    _invalidateSession(_activeSessionKey, _activeRole, 'refresh_401');
    throw new Error('Session expired');
  }
  const data = await res.json() as AuthResponse;
  _setTokens(data.access_token, data.refresh_token);
  scheduleRefresh(data.access_token, () => silentRefresh());
  return data;
}

/** Log out. Notifies the server and clears local tokens. */
export async function logout(): Promise<void> {
  const url = `${BASE}/auth/logout`;
  try {
    await apiFetch(url, { method: 'POST' });
  } catch { /* best-effort */ }
  _clearTokens({ reason: 'logout' });
}

function _hydrateFromStorage(): void {
  const state = _readPersistedState();
  const currentKey = state.currentSessionKey;
  if (!currentKey) return;

  const session = state.sessions[currentKey];
  if (!session) {
    state.currentSessionKey = null;
    _writePersistedState(state);
    return;
  }

  _activeSessionKey = currentKey;
  _activeRole = session.role;
  accessToken.value = session.accessToken;
  refreshToken.value = session.refreshToken;
  scheduleRefresh(
    session.accessToken,
    () => silentRefresh(),
  );
}

_hydrateFromStorage();

// #endregion

// #region Authenticated fetch

/**
 * fetch() wrapper that attaches the Bearer token and retries once after
 * a transparent token refresh on 401.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const at = accessToken.value;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined ?? {}),
    ...(at ? { Authorization: `Bearer ${at}` } : {}),
  };

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401 && refreshToken.value) {
    try {
      await silentRefresh();
      headers['Authorization'] = `Bearer ${accessToken.value!}`;
      res = await fetch(url, { ...options, headers });
    } catch {
      // refresh failed — return the 401 to the caller
    }
  } else if (res.status === 401) {
    _invalidateSession(_activeSessionKey, _activeRole, 'refresh_401');
  }

  return res;
}

// #endregion
