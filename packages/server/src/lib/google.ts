import fs from 'fs';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export interface GoogleOAuthCredentials extends GoogleOAuthClient {
  refreshToken: string;
}

type Environment = Record<string, string | undefined>;

interface GoogleOAuthDocument {
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
}

export function loadGoogleOAuthClientFromFile(filePath: string): GoogleOAuthClient | null {
  let raw: GoogleOAuthDocument;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GoogleOAuthDocument;
  } catch {
    throw new Error('Unable to read or parse GOOGLE_OAUTH_JSON_PATH');
  }
  const payload = raw.installed ?? raw.web;

  if (!payload?.client_id || !payload.client_secret) {
    return null;
  }

  return {
    clientId: payload.client_id,
    clientSecret: payload.client_secret,
    redirectUri: payload.redirect_uris?.[0],
  };
}

function parseRefreshToken(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { refresh_token?: unknown; refreshToken?: unknown };
    const token = parsed.refresh_token ?? parsed.refreshToken;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return value.trim() || null;
  }
}

export function resolveGoogleOAuthClient(env: Environment = process.env): GoogleOAuthClient | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error(
        'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be configured together',
      );
    }
    return { clientId, clientSecret };
  }

  const filePath = env.GOOGLE_OAUTH_JSON_PATH?.trim();
  return filePath ? loadGoogleOAuthClientFromFile(filePath) : null;
}

export function resolveGoogleOAuthRefreshToken(
  env: Environment = process.env,
  directKeys: readonly string[] = ['GOOGLE_OAUTH_REFRESH_TOKEN'],
): string | null {
  for (const key of directKeys) {
    const value = env[key]?.trim();
    if (!value) continue;
    const token = parseRefreshToken(value);
    if (!token) throw new Error(`${key} does not contain a Google OAuth refresh token`);
    return token;
  }

  const filePath = env.GOOGLE_OAUTH_REFRESH_TOKEN_PATH?.trim();
  if (!filePath) return null;
  const token = parseRefreshToken(fs.readFileSync(filePath, 'utf8').trim());
  if (!token) {
    throw new Error('GOOGLE_OAUTH_REFRESH_TOKEN_PATH does not contain a refresh token');
  }
  return token;
}

export function resolveGoogleOAuthCredentials(options: {
  env?: Environment;
  refreshTokenKeys?: readonly string[];
} = {}): GoogleOAuthCredentials | null {
  const env = options.env ?? process.env;
  const client = resolveGoogleOAuthClient(env);
  const refreshToken = resolveGoogleOAuthRefreshToken(env, options.refreshTokenKeys);
  return client && refreshToken ? { ...client, refreshToken } : null;
}

export async function fetchGoogleAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed with status ${response.status}`);
  }

  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Google OAuth token exchange did not return an access token');
  }

  return payload.access_token;
}
