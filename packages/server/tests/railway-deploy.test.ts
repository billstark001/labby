import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRailwayDeployArguments, shouldDeployRailway } from '../../../scripts/railway-deploy.js';

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
