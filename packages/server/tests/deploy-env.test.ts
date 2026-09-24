import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDeploymentEnvPlan, diffDeploymentEnvironment, encodeGcloudDictionary, parseDeploymentEnvArguments, SERVER_RUNTIME_ENV_KEYS } from '../../../scripts/deploy-env.js';

test('server example documents every runtime environment variable', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const documented = new Set(
    [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );
  assert.deepEqual(
    SERVER_RUNTIME_ENV_KEYS.filter((key) => !documented.has(key)),
    [],
  );
});

test('provider examples document portable Google OAuth credentials', async () => {
  for (const file of [
    '../.env.railway.production.example',
    '../.env.cloudrun.production.example',
  ]) {
    const example = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(example, /^GOOGLE_OAUTH_CLIENT_ID=/m);
    assert.match(example, /^GOOGLE_OAUTH_CLIENT_SECRET=/m);
    assert.match(example, /^GOOGLE_OAUTH_REFRESH_TOKEN=/m);
  }
});

test('deployment env arguments keep empty-value sync separate from explicit deletion', () => {
  const parsed = parseDeploymentEnvArguments(
    ['--env-build', 'railway.production', '--delete-env=OLD_KEY,SECOND_KEY', '--delete-env', 'OLD_KEY', '--full'],
    'local',
  );
  assert.deepEqual(parsed.env, {
    sync: true,
    build: 'railway.production',
    deleteKeys: ['OLD_KEY', 'SECOND_KEY'],
  });
  assert.deepEqual(parsed.remaining, ['--full']);
  assert.throws(
    () => parseDeploymentEnvArguments(['--no-env-sync', '--delete-env', 'OLD_KEY'], 'local'),
    /cannot be used/,
  );
});

test('env-lane deployment plan preserves explicit empty values and deletion wins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'labby-env-lane-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true,"type":"module"}\n');
    await writeFile(
      path.join(root, 'env-lane.config.mjs'),
      `export default {
        selector: { defaultBuild: 'local', builds: ['local', 'railway.production'], buildValidation: 'error' },
        workspace: { aliases: { server: '.' }, defaultTarget: 'server', includeRoot: true },
        dotenv: { order: ['.env', '.env.{build}'], includeProcessEnv: false }
      };\n`,
    );
    await writeFile(path.join(root, '.env'), 'VALUE=base\nEMPTY=base\nDELETE_ME=present\nUNMANAGED=ignored\n');
    await writeFile(path.join(root, '.env.railway.production'), 'VALUE=override\nEMPTY=\n');

    const plan = await buildDeploymentEnvPlan({
      root,
      build: 'railway.production',
      allowedKeys: ['VALUE', 'EMPTY', 'DELETE_ME'],
      deleteKeys: ['DELETE_ME'],
    });

    assert.deepEqual(plan.files, ['.env', '.env.railway.production']);
    assert.deepEqual(plan.updates, { VALUE: 'override', EMPTY: '' });
    assert.deepEqual(plan.deletes, ['DELETE_ME']);
    assert.equal(Object.hasOwn(plan.updates, 'UNMANAGED'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cloud Run dictionary encoding preserves commas and empty values', () => {
  assert.equal(
    encodeGcloudDictionary({ RECIPIENTS: 'one@example.com,two@example.com', EMPTY: '' }),
    '^|^RECIPIENTS=one@example.com,two@example.com|EMPTY=',
  );
  assert.equal(encodeGcloudDictionary({}), null);
});

test('remote diff treats empty as a value and deletes only named existing keys', () => {
  assert.deepEqual(
    diffDeploymentEnvironment(
      { SAME: 'value', EMPTY: 'old', DELETE_ME: '', KEEP: 'remote' },
      { SAME: 'value', EMPTY: '', NEW: 'new' },
      ['DELETE_ME', 'MISSING'],
    ),
    { updates: [['EMPTY', ''], ['NEW', 'new']], deletes: ['DELETE_ME'] },
  );
});
