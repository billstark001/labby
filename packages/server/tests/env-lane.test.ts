import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveInjectedEnv, sortEnvFilesFromConfig } from '@env-lane/core';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('env-lane')), process.platform === 'win32' ? 'env-lane.exe' : 'env-lane');
const lanes = ['railway.production', 'railway.cron.production', 'cloudrun.production'];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'labby-env-lane-json5-'));
  try {
    await mkdir(path.join(root, 'packages/server'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true}');
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    await writeFile(path.join(root, 'packages/server/package.json'), '{"name":"@labby/server","private":true}');
    await writeFile(path.join(root, 'env-lane.config.json5'), await readFile(path.join(repositoryRoot, 'env-lane.config.json5')));
    await writeFile(path.join(root, '.env'), 'ROOT_ONLY=ignored\n');
    await writeFile(path.join(root, 'packages/server/.env'), '# Preserve this comment\nEXTRA=keep\nVALUE=base\nEMPTY=base\nMULTILINE="first\nsecond"\n');
    await writeFile(path.join(root, 'packages/server/.env.local'), 'VALUE=local\n');
    await writeFile(path.join(root, 'packages/server/.env.example'), '# Base template\nEMPTY=\nVALUE=\nMULTILINE=\n');
    for (const lane of lanes) {
      await writeFile(path.join(root, `packages/server/.env.${lane}`), `VALUE=${lane}\nEMPTY=\n`);
      await writeFile(path.join(root, `packages/server/.env.${lane}.example`), '# Provider template\nEMPTY=\nVALUE=\n');
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('project JSON5 resolves every lane from root and server directories', async () => {
  const root = await fixture();
  try {
    for (const cwd of [root, path.join(root, 'packages/server')]) {
      for (const build of ['local', ...lanes]) {
        const result = await resolveInjectedEnv({ cwd, target: 'server', build, includeProcessEnv: false });
        assert.equal(result.values.VALUE, build);
        assert.equal(result.values.EMPTY, build === 'local' ? 'base' : '');
        assert.equal(result.values.MULTILINE, 'first\nsecond');
        assert.equal(Object.hasOwn(result.values, 'ROOT_ONLY'), false);
        assert.deepEqual(result.files.map(file => file.relativePath), ['packages/server/.env', `packages/server/.env.${build}`]);
      }
    }
    await assert.rejects(resolveInjectedEnv({ cwd: root, build: 'unknown' }), /build/i);
    await writeFile(path.join(root, 'packages/server/.env.local'), 'ENV_BUILD=railway.production\n');
    await assert.rejects(resolveInjectedEnv({ cwd: root, build: 'local', includeProcessEnv: false }), /ENV_BUILD/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configured sorting preserves values, comments and skips absent private files', async () => {
  const root = await fixture();
  try {
    for (const [target, build] of [['server', 'local'], ['server-local', 'local'], ...lanes.map(lane => [lane.replaceAll('.', '-'), lane])]) {
      const before = await resolveInjectedEnv({ cwd: root, build, includeProcessEnv: false });
      const preview = await sortEnvFilesFromConfig(undefined, target, 'configured', { cwd: root, check: true });
      assert.equal(preview.count, 1);
      const file = preview.results[0].filePath;
      const original = await readFile(file, 'utf8');
      await sortEnvFilesFromConfig(undefined, target, 'configured', { cwd: root, check: true });
      assert.equal(await readFile(file, 'utf8'), original);
      await sortEnvFilesFromConfig(undefined, target, 'configured', { cwd: root });
      const after = await resolveInjectedEnv({ cwd: root, build, includeProcessEnv: false });
      assert.deepEqual(after.values, before.values);
      const check = await sortEnvFilesFromConfig(undefined, target, 'configured', { cwd: root, check: true });
      assert.equal(check.changed, false);
    }
    assert.match(await readFile(path.join(root, 'packages/server/.env'), 'utf8'), /Preserve this comment/);
    const absent = path.join(root, 'packages/server/.env.cloudrun.production');
    await rm(absent);
    await sortEnvFilesFromConfig(undefined, 'cloudrun-production', 'configured', { cwd: root });
    await assert.rejects(readFile(absent), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native CLI reads JSON5 without Node on PATH and preserves child streams and status', async () => {
  const root = await fixture();
  const cwd = path.join(root, 'packages/server');
  // This environment contains synthetic values only. The child uses an absolute Node path.
  const env = { PATH: '', ENV_BUILD: 'railway.production', VALUE: 'shell', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  try {
    const run = (source: string, input?: string) => spawnSync(cli, ['run', 'server', '--quiet', '--', process.execPath, '-e', source], { cwd, env, input, encoding: 'utf8', timeout: 10_000 });
    const result = run("const fs = require('node:fs'); if (process.env.VALUE !== 'shell' || process.env.EMPTY !== '' || process.env.ROOT_ONLY !== undefined) process.exit(99); process.stdout.write(fs.readFileSync(0)); process.stderr.write('child-stderr'); process.exit(37);", 'child-stdin');
    assert.ifError(result.error);
    assert.equal(result.status, 37);
    assert.equal(result.stdout, 'child-stdin');
    assert.equal(result.stderr, 'child-stderr');
    if (process.platform !== 'win32') {
      const signaled = run("process.kill(process.pid, 'SIGTERM');");
      assert.ifError(signaled.error);
      assert.equal(signaled.signal, 'SIGTERM');
    }
    const missing = spawnSync(cli, ['run', 'server', '--quiet', '--', 'labby-nonexistent-test-command'], { cwd, env, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(missing.error);
    assert.equal(missing.status, 127);
    assert.equal(missing.stdout, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
