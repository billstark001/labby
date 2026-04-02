import fs from 'fs';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

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
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GoogleOAuthDocument;
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

export async function fetchGoogleAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
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
