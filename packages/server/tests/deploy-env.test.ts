import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDeploymentEnvPlan, diffDeploymentEnvironment, encodeGcloudDictionary, parseDeploymentEnvArguments, SERVER_RUNTIME_ENV_KEYS } from '../../../scripts/deploy-env.js';
import { readPrivateCredentialFile } from '../../../scripts/deploy-file-credentials.js';

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
      { SAME: 'value', EMPTY: 'old', DELETE_ME: '', KEEP: 'remote', SEALED: null },
      { SAME: 'value', EMPTY: '', NEW: 'new', SEALED: 'local-value' },
      ['DELETE_ME', 'MISSING'],
    ),
    { updates: [['EMPTY', ''], ['NEW', 'new']], deletes: ['DELETE_ME'] },
  );
});

test('Railway credential expansion reads the JSON selected by the env lane', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'labby-service-account-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true,"type":"module"}\n');
    await writeFile(path.join(root, 'env-lane.config.mjs'), `export default {
      selector: { defaultBuild: 'local', builds: ['local', 'railway.production'], buildValidation: 'error' },
      workspace: { aliases: { server: '.' }, defaultTarget: 'server', includeRoot: true },
      dotenv: { order: ['.env', '.env.{build}'], includeProcessEnv: false }
    };\n`);
    const baseCredential = path.join(root, 'google-base.json');
    const laneCredential = path.join(root, 'google-lane.json');
    const oauthClient = path.join(root, 'google-oauth-client.json');
    const oauthToken = path.join(root, 'google-oauth-token.json');
    await writeFile(baseCredential, JSON.stringify({ type: 'service_account', project_id: 'base-project', client_email: 'base@example.gserviceaccount.com', private_key: privateKey }), { mode: 0o600 });
    await writeFile(laneCredential, JSON.stringify({ type: 'service_account', project_id: 'lane-project', client_email: 'lane@example.gserviceaccount.com', private_key: privateKey }), { mode: 0o600 });
    await writeFile(oauthClient, JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'client-secret' } }), { mode: 0o600 });
    await writeFile(oauthToken, JSON.stringify({ refresh_token: 'refresh-value' }), { mode: 0o600 });
    await writeFile(path.join(root, '.env'), 'GOOGLE_CLOUD_CLIENT_EMAIL=base@example.gserviceaccount.com\nGOOGLE_CLOUD_PRIVATE_KEY=base-key\nGOOGLE_APPLICATION_CREDENTIALS=google-base.json\nGOOGLE_OAUTH_CLIENT_ID=base-client\nGOOGLE_OAUTH_CLIENT_SECRET=base-secret\nGOOGLE_OAUTH_REFRESH_TOKEN=base-refresh\nGOOGLE_OAUTH_JSON_PATH=google-oauth-client.json\nGOOGLE_OAUTH_REFRESH_TOKEN_PATH=google-oauth-token.json\n');
    await writeFile(path.join(root, '.env.railway.production'), 'GOOGLE_APPLICATION_CREDENTIALS=google-lane.json\nGOOGLE_OAUTH_JSON_PATH=google-oauth-client.json\nGOOGLE_OAUTH_REFRESH_TOKEN_PATH=google-oauth-token.json\n');

    const plan = await buildDeploymentEnvPlan({
      root, build: 'railway.production', allowedKeys: ['GOOGLE_CLOUD_CLIENT_EMAIL', 'GOOGLE_CLOUD_PRIVATE_KEY', 'CLOUD_SCHEDULER_PROJECT_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_JSON_PATH', 'GOOGLE_OAUTH_REFRESH_TOKEN_PATH'], expandFileCredentials: true,
    });
    assert.equal(plan.updates.GOOGLE_CLOUD_CLIENT_EMAIL, 'lane@example.gserviceaccount.com');
    assert.equal(plan.updates.CLOUD_SCHEDULER_PROJECT_ID, 'lane-project');
    assert.equal(plan.updates.GOOGLE_CLOUD_PRIVATE_KEY, privateKey);
    assert.equal(plan.updates.GOOGLE_OAUTH_CLIENT_ID, 'client-id');
    assert.equal(plan.updates.GOOGLE_OAUTH_CLIENT_SECRET, 'client-secret');
    assert.equal(plan.updates.GOOGLE_OAUTH_REFRESH_TOKEN, 'refresh-value');
    assert.deepEqual(new Set(plan.expandedKeys), new Set([
      'GOOGLE_CLOUD_CLIENT_EMAIL', 'GOOGLE_CLOUD_PRIVATE_KEY', 'CLOUD_SCHEDULER_PROJECT_ID',
      'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
    ]));
    assert.equal(Object.hasOwn(plan.updates, 'GOOGLE_APPLICATION_CREDENTIALS'), false);
    assert.equal(Object.hasOwn(plan.updates, 'GOOGLE_OAUTH_JSON_PATH'), false);
    assert.equal(Object.hasOwn(plan.updates, 'GOOGLE_OAUTH_REFRESH_TOKEN_PATH'), false);

    await writeFile(path.join(root, '.env.railway.production'), 'GOOGLE_APPLICATION_CREDENTIALS=missing.json\nGOOGLE_CLOUD_CLIENT_EMAIL=direct@example.gserviceaccount.com\nGOOGLE_CLOUD_PRIVATE_KEY=direct-key\nGOOGLE_OAUTH_JSON_PATH=missing.json\nGOOGLE_OAUTH_CLIENT_ID=direct-client\nGOOGLE_OAUTH_CLIENT_SECRET=direct-secret\nGOOGLE_OAUTH_REFRESH_TOKEN_PATH=missing.json\nGOOGLE_OAUTH_REFRESH_TOKEN=direct-refresh\n');
    const directPlan = await buildDeploymentEnvPlan({
      root, build: 'railway.production', allowedKeys: SERVER_RUNTIME_ENV_KEYS, expandFileCredentials: true,
    });
    assert.equal(directPlan.updates.GOOGLE_CLOUD_CLIENT_EMAIL, 'direct@example.gserviceaccount.com');
    assert.equal(directPlan.updates.GOOGLE_OAUTH_CLIENT_ID, 'direct-client');
    assert.equal(directPlan.updates.GOOGLE_OAUTH_REFRESH_TOKEN, 'direct-refresh');
    assert.deepEqual(directPlan.expandedKeys, []);

    await writeFile(path.join(root, '.env.railway.production'), 'GOOGLE_APPLICATION_CREDENTIALS=google-lane.json\nGOOGLE_CLOUD_CLIENT_EMAIL=partial@example.gserviceaccount.com\n');
    await assert.rejects(buildDeploymentEnvPlan({
      root, build: 'railway.production', allowedKeys: SERVER_RUNTIME_ENV_KEYS, expandFileCredentials: true,
    }), /must be set together/);

    await chmod(laneCredential, 0o644);
    await assert.rejects(readPrivateCredentialFile(laneCredential), /private regular file/);
    await chmod(laneCredential, 0o600);
    await chmod(laneCredential, 0o700);
    await assert.rejects(readPrivateCredentialFile(laneCredential), /private regular file/);
    await chmod(laneCredential, 0o600);
    const symlinkPath = path.join(root, 'google-symlink.json');
    await symlink(laneCredential, symlinkPath);
    await assert.rejects(readPrivateCredentialFile(symlinkPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
