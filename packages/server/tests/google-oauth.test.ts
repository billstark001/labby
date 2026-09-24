import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBackupServiceFromEnv } from '../src/backup/service.js';
import {
  resolveGoogleOAuthClient,
  resolveGoogleOAuthCredentials,
} from '../src/lib/google.js';
import { createMailerFromEnv } from '../src/lib/mailer.js';

test('direct Google OAuth client variables take precedence and require a pair', () => {
  assert.deepEqual(
    resolveGoogleOAuthClient({
      GOOGLE_OAUTH_CLIENT_ID: 'direct-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'direct-secret',
      GOOGLE_OAUTH_JSON_PATH: '/does/not/exist',
    }),
    { clientId: 'direct-id', clientSecret: 'direct-secret' },
  );
  assert.throws(
    () => resolveGoogleOAuthClient({ GOOGLE_OAUTH_CLIENT_ID: 'incomplete' }),
    /must be configured together/,
  );
});

test('Google OAuth credentials support direct and file-backed refresh tokens', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'labby-google-oauth-'));
  const clientPath = path.join(directory, 'client.json');
  const tokenPath = path.join(directory, 'token.json');
  try {
    await writeFile(clientPath, JSON.stringify({ installed: {
      client_id: 'file-id',
      client_secret: 'file-secret',
      redirect_uris: ['http://localhost'],
    } }));
    await writeFile(tokenPath, JSON.stringify({ refresh_token: 'file-token' }));

    assert.deepEqual(
      resolveGoogleOAuthCredentials({
        env: {
          GOOGLE_OAUTH_CLIENT_ID: 'direct-id',
          GOOGLE_OAUTH_CLIENT_SECRET: 'direct-secret',
          GMAIL_REFRESH_TOKEN: 'gmail-token',
          GOOGLE_OAUTH_REFRESH_TOKEN: 'shared-token',
        },
        refreshTokenKeys: ['GMAIL_REFRESH_TOKEN', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
      }),
      { clientId: 'direct-id', clientSecret: 'direct-secret', refreshToken: 'gmail-token' },
    );
    assert.deepEqual(
      resolveGoogleOAuthCredentials({
        env: {
          GOOGLE_OAUTH_JSON_PATH: clientPath,
          GOOGLE_OAUTH_REFRESH_TOKEN_PATH: tokenPath,
        },
      }),
      {
        clientId: 'file-id',
        clientSecret: 'file-secret',
        redirectUri: 'http://localhost',
        refreshToken: 'file-token',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gmail and Google Drive consume the unified credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'labby-google-services-'));
  const tokenPath = path.join(directory, 'token.json');
  const keys = [
    'SMTP_PROVIDER',
    'SMTP_FROM',
    'GMAIL_USER',
    'GMAIL_REFRESH_TOKEN',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN_PATH',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    await writeFile(tokenPath, JSON.stringify({ refresh_token: 'file-token' }));
    process.env.SMTP_PROVIDER = 'gmail';
    process.env.SMTP_FROM = 'sender@example.com';
    process.env.GMAIL_USER = 'sender@example.com';
    process.env.GMAIL_REFRESH_TOKEN = 'gmail-token';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'direct-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'direct-secret';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN_PATH = tokenPath;

    assert.ok(createMailerFromEnv());
    delete process.env.GMAIL_REFRESH_TOKEN;
    const backup = createBackupServiceFromEnv({
      scheduler: {} as never,
      store: {} as never,
      mailer: null,
    });
    assert.equal(backup.getCapabilities().targets['google-drive'], true);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
