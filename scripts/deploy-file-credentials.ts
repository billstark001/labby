import { createPrivateKey } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Never follow symlinks or read files accessible to another local user. */
export async function readPrivateCredentialFile(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Credential file could not be opened securely');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES || (stat.mode & 0o177) !== 0) {
      throw new Error('Credential file must be a private regular file of at most 64 KiB');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Credential file must be owned by the current user');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Credential file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credential file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function parseGoogleServiceAccount(raw: string): Record<string, string> {
  const value = parseJsonObject(raw);
  if (value.type !== 'service_account'
    || typeof value.project_id !== 'string' || !value.project_id
    || typeof value.client_email !== 'string' || !value.client_email.endsWith('.gserviceaccount.com')
    || typeof value.private_key !== 'string' || !value.private_key) {
    throw new Error('Google service account file is missing required fields');
  }
  try {
    createPrivateKey(value.private_key);
  } catch {
    throw new Error('Google service account file has an invalid private key');
  }
  return {
    CLOUD_SCHEDULER_PROJECT_ID: value.project_id,
    GOOGLE_CLOUD_CLIENT_EMAIL: value.client_email,
    GOOGLE_CLOUD_PRIVATE_KEY: value.private_key,
  };
}

export function parseGoogleOAuthClient(raw: string): Record<string, string> {
  const value = parseJsonObject(raw);
  const installed = value.installed;
  const web = value.web;
  const payload = installed && typeof installed === 'object' ? installed : web;
  const client = payload as Record<string, unknown> | undefined;
  if (!client || typeof client.client_id !== 'string' || !client.client_id
    || typeof client.client_secret !== 'string' || !client.client_secret) {
    throw new Error('Google OAuth client file is missing required fields');
  }
  return { GOOGLE_OAUTH_CLIENT_ID: client.client_id, GOOGLE_OAUTH_CLIENT_SECRET: client.client_secret };
}

export function parseGoogleOAuthRefreshToken(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  let token = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      token = typeof (value.refresh_token ?? value.refreshToken) === 'string'
        ? String(value.refresh_token ?? value.refreshToken).trim()
        : '';
    } else if (typeof parsed === 'string') {
      token = parsed.trim();
    }
  } catch {
    // A plain refresh token is also a supported file format.
  }
  if (!token) throw new Error('Google OAuth refresh token file is empty or invalid');
  return { GOOGLE_OAUTH_REFRESH_TOKEN: token };
}
