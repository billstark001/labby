import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseRailwayDeployArguments, railwayScopeArgs, shouldDeployRailway, syncRailwayEnvironment } from '../../../scripts/railway-deploy.js';

test('Railway deploy scopes each target even when a different service is linked', () => {
  assert.deepEqual(railwayScopeArgs('server', {}), ['--service', 'labby-api']);
  assert.deepEqual(railwayScopeArgs('cron', {}), ['--service', 'labby-auth-cleanup']);
  assert.deepEqual(railwayScopeArgs('cron', { RAILWAY_SERVICE: 'custom-cron' }), ['--service', 'custom-cron']);
  assert.deepEqual(railwayScopeArgs('server', {
    RAILWAY_SERVICE: 'custom-api',
    RAILWAY_ENVIRONMENT: 'production',
    RAILWAY_PROJECT_ID: 'project-id',
  }), ['--service', 'custom-api', '--environment', 'production', '--project', 'project-id']);
  assert.throws(() => railwayScopeArgs('cron', { RAILWAY_SERVICE: 'custom-cron', RAILWAY_PROJECT_ID: 'project-id' }), /requires RAILWAY_ENVIRONMENT/);
});

test('Railway incremental deploy selects only files used by its service image', () => {
  assert.equal(shouldDeployRailway(['docs/deploy-railway.md'], 'server'), false);
  assert.equal(shouldDeployRailway(['packages/server/src/index.ts'], 'server'), true);
  assert.equal(shouldDeployRailway(['packages/web/src/App.tsx'], 'server'), true);
  assert.equal(shouldDeployRailway(['.railway/railway.ts'], 'server'), true);

  assert.equal(shouldDeployRailway(['packages/server/src/cron/railway-dispatch.ts'], 'cron'), true);
  assert.equal(shouldDeployRailway(['packages/web/src/App.tsx'], 'cron'), false);
  assert.equal(shouldDeployRailway(['.railway/railway.ts'], 'cron'), true);
});

test('Railway deploy arguments reject ambiguous and stray values', () => {
  assert.deepEqual(parseRailwayDeployArguments(['--full', '--target', 'cron']), {
    incremental: false,
    target: 'cron',
  });
  assert.throws(() => parseRailwayDeployArguments(['--full', '--incremental']), /exactly one/);
  assert.throws(() => parseRailwayDeployArguments(['--full', 'cron']), /Unknown argument/);
  assert.throws(() => parseRailwayDeployArguments(['--full', '--target']), /server or cron/);
});

test('Railway sync sends extracted values through stdin and refuses sealed file-derived values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'labby-railway-cli-'));
  const executable = path.join(directory, 'railway-mock');
  const record = path.join(directory, 'record.jsonl');
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'variable' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ OLD: 'remove', SEALED: null }));
} else {
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input: fs.readFileSync(0, 'utf8') }) + '\\n');
  process.stdout.write('{}');
}
`);
    await chmod(executable, 0o700);
    assert.equal(syncRailwayEnvironment(executable, ['--service', 'labby-api'], { NEW: 'private-value', SEALED: 'keep' }, ['OLD'], ['NEW']), true);
    const events = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string });
    assert.deepEqual(events.map((event) => event.args.slice(0, 3)), [
      ['variable', 'delete', 'OLD'],
      ['variable', 'set', 'NEW'],
    ]);
    assert.equal(events[1]?.input, 'private-value');
    assert.equal(events[1]?.args.includes('private-value'), false);
    assert.throws(() => syncRailwayEnvironment(executable, [], { SEALED: 'changed' }, [], ['SEALED']), /cannot be synchronized by CLI/);
    assert.equal((await readFile(record, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
