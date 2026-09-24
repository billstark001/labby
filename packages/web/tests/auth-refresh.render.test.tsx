import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { accessToken, apiFetch, AuthRefreshError, login, refreshToken, silentRefresh } from '../src/lib/auth';

const tokens = { access_token: 'access-new', refresh_token: 'refresh-new', token_type: 'Bearer' };
const response = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, tokens)));
  await login('person@example.test', 'password');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refresh failures preserve session state', () => {
  test('401 followed by refresh 500 reports the 500 and keeps tokens', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(500, { message: 'database unavailable' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiFetch('/api/v1/db/persons')).rejects.toMatchObject({ status: 500 });
    expect(accessToken.value).toBe(tokens.access_token);
    expect(refreshToken.value).toBe(tokens.refresh_token);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('active refresh 500 and network failure keep tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(500)));
    await expect(silentRefresh()).rejects.toMatchObject({ status: 500 });
    expect(refreshToken.value).toBe(tokens.refresh_token);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(silentRefresh()).rejects.toMatchObject({ status: null });
    expect(accessToken.value).toBe(tokens.access_token);
  });

  test('confirmed refresh 401 invalidates tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)));
    await expect(silentRefresh()).rejects.toBeInstanceOf(AuthRefreshError);
    expect(accessToken.value).toBeNull();
    expect(refreshToken.value).toBeNull();
  });

  test('refresh 403 preserves tokens and reports its actual status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403)));
    await expect(silentRefresh()).rejects.toMatchObject({ status: 403 });
    expect(accessToken.value).toBe(tokens.access_token);
  });

  test('concurrent unauthorized requests share one refresh', async () => {
    let refreshCalls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get('Authorization');
      if (_url.endsWith('/auth/refresh')) { refreshCalls++; return response(200, tokens); }
      return bearer === `Bearer ${tokens.access_token}` ? response(200, { ok: true }) : response(401);
    });
    vi.stubGlobal('fetch', fetcher);
    accessToken.value = 'access-old';
    const results = await Promise.all([apiFetch('/api/v1/a'), apiFetch('/api/v1/b')]);
    expect(results.map(item => item.status)).toEqual([200, 200]);
    expect(refreshCalls).toBe(1);
  });
});
