import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';

function createTempDbPath(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, 'labby.db');
}

function createTempWebDist(): string {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labby-web-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body><div id="app">Labby</div></body></html>');
  fs.writeFileSync(path.join(distDir, 'assets', 'main.js'), 'console.log("labby");');
  return distDir;
}

test('server serves web dist static files and SPA fallback when webDistDir is configured', async () => {
  const runtime = await createApp({
    db: { dialect: 'sqlite', path: createTempDbPath('labby-static-serve') },
    rootUsername: 'root',
    rootPassword: 'root-pass',
    webDistDir: createTempWebDist(),
  });

  try {
    const home = await runtime.app.request('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await home.text(), /Labby/);

    const asset = await runtime.app.request('/assets/main.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);

    const spaRoute = await runtime.app.request('/persons');
    assert.equal(spaRoute.status, 200);
    assert.match(spaRoute.headers.get('content-type') ?? '', /text\/html/);

    const missingApi = await runtime.app.request('/api/v1/unknown', {
      headers: {
        'X-Request-Id': 'test-request-id',
      },
    });
    assert.equal(missingApi.status, 404);
  } finally {
    await runtime.close();
  }
});
