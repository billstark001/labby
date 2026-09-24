import assert from 'node:assert/strict';
import test from 'node:test';

import { Mailer } from '../src/lib/mailer.js';

function gmailApiMailer(): Mailer {
  return new Mailer({
    mode: 'gmail-api',
    user: 'sender@example.com',
    from: 'sender@example.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
  });
}

test('Gmail API sends multipart mail with attachments over HTTPS', async (context) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(init?.signal?.aborted, false);
      return Response.json({ access_token: 'access-token' });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer access-token');
      assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
      assert.equal(init.signal, requests[0]?.init?.signal);
      return Response.json({ id: 'message-id' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  await gmailApiMailer().send({
    to: 'recipient@example.com',
    subject: 'Report',
    fromName: 'Labby',
    text: 'Plain report',
    html: '<b>HTML report</b>',
    attachments: [{ filename: 'report.txt', content: Buffer.from('report bytes'), contentType: 'text/plain' }],
  });

  assert.equal(requests.length, 2);
  const body = JSON.parse(String(requests[1]?.init?.body)) as { raw: string };
  const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
  assert.match(mime, /From: Labby <sender@example\.com>/);
  assert.match(mime, /To: recipient@example\.com/);
  assert.match(mime, /Subject: Report/);
  assert.match(mime, /Plain report/);
  assert.match(mime, /HTML report/);
  assert.match(mime, /filename=report\.txt/);
  assert.match(mime, /cmVwb3J0IGJ5dGVz/);
});

test('Gmail API verification checks the authorized mailbox without sending mail', async (context) => {
  const urls: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-token' });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
      return Response.json({ emailAddress: 'sender@example.com' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  assert.equal(await gmailApiMailer().verify(), true);
  assert.deepEqual(urls, [
    'https://oauth2.googleapis.com/token',
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  ]);
});

test('Gmail API send reports HTTP errors to the caller', async (context) => {
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'access-token' });
    }
    return Response.json({ error: 'forbidden' }, { status: 403 });
  });

  await assert.rejects(
    gmailApiMailer().send({ to: 'recipient@example.com', subject: 'Report', text: 'Hello' }),
    /Gmail API send failed with status 403/,
  );
});
