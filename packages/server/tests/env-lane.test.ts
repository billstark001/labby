import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
      await writeFile(path.join(root, `packages/server/.env.${lane}.example`), `# Provider template ${lane}\nEMPTY=\nVALUE=\n`);
    }
    return await realpath(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function sortCommand(root: string, script: 'env:sort' | 'env:sort:check', args: string[] = [], cwd = root) {
  const { scripts } = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const [executable, ...commandArgs] = scripts[script].split(' ');
  assert.equal(executable, 'env-lane');
  const result = spawnSync(cli, [...commandArgs, ...args, '--json', '--non-interactive'], {
    cwd,
    env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

async function snapshot(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file), entry.isFile() ? await readFile(file, 'utf8') : null];
  }));
  return files.sort(([a], [b]) => String(a).localeCompare(String(b)));
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
      const preview = await sortEnvFilesFromConfig(undefined, target, 'default', { cwd: root, check: true });
      assert.equal(preview.count, 1);
      const file = preview.results[0].filePath;
      const original = await readFile(file, 'utf8');
      await sortEnvFilesFromConfig(undefined, target, 'default', { cwd: root, check: true });
      assert.equal(await readFile(file, 'utf8'), original);
      await sortEnvFilesFromConfig(undefined, target, 'default', { cwd: root });
      const after = await resolveInjectedEnv({ cwd: root, build, includeProcessEnv: false });
      assert.deepEqual(after.values, before.values);
      const check = await sortEnvFilesFromConfig(undefined, target, 'default', { cwd: root, check: true });
      assert.equal(check.changed, false);
    }
    assert.match(await readFile(path.join(root, 'packages/server/.env'), 'utf8'), /Preserve this comment/);
    const absent = path.join(root, 'packages/server/.env.cloudrun.production');
    await rm(absent);
    await sortEnvFilesFromConfig(undefined, 'cloudrun-production', 'default', { cwd: root });
    await assert.rejects(readFile(absent), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native sort scripts batch only configured files with their own templates and check without writes', async () => {
  const root = await fixture();
  const server = path.join(root, 'packages/server');
  const expectedFiles = ['.env', '.env.local', ...lanes.map(lane => `.env.${lane}`)];
  try {
    await mkdir(path.join(root, 'packages/web'));
    await writeFile(path.join(root, 'packages/web/package.json'), '{"name":"@labby/web"}');
    await writeFile(path.join(root, 'packages/web/.env'), 'WEB_ONLY=untouched\n');
    await writeFile(path.join(server, '.env.extra'), 'EXTRA_FILE=untouched\n');
    const original = await snapshot(root);
    const before = await Promise.all(['local', ...lanes].map(build =>
      resolveInjectedEnv({ cwd: root, build, includeProcessEnv: false })));
    for (const cwd of [root, server]) {
      const check = await sortCommand(root, 'env:sort:check', [], cwd);
      assert.equal(check.status, 1, check.stderr);
      const result = JSON.parse(check.stdout);
      assert.equal(result.count, 5);
      assert.equal(result.missingCount, 0);
      assert.deepEqual(result.results.map((file: { filePath: string }) => path.relative(server, file.filePath)), expectedFiles);
      assert.deepEqual(await snapshot(root), original);
    }
    const sorted = await sortCommand(root, 'env:sort');
    assert.equal(sorted.status, 0, sorted.stderr);
    for (const [index, build] of ['local', ...lanes].entries()) {
      const after = await resolveInjectedEnv({ cwd: root, build, includeProcessEnv: false });
      assert.deepEqual(after.values, before[index].values);
    }
    for (const lane of lanes) {
      assert.ok((await readFile(path.join(server, `.env.${lane}`), 'utf8')).includes(`# Provider template ${lane}`));
    }
    for (const file of ['.env', 'packages/web/.env', 'packages/server/.env.extra']) {
      assert.equal(await readFile(path.join(root, file), 'utf8'), original.find(([name]) => name === file)?.[1]);
    }
    const afterSort = await snapshot(root);
    for (const cwd of [root, server]) {
      const check = await sortCommand(root, 'env:sort:check', [], cwd);
      assert.equal(check.status, 0, check.stderr);
      assert.equal(JSON.parse(check.stdout).changed, false);
      assert.deepEqual(await snapshot(root), afterSort);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native sort validates selections before writing and can sort a single provider file', async () => {
  const root = await fixture();
  const server = path.join(root, 'packages/server');
  try {
    const original = await snapshot(root);
    for (const [args, code] of [
      [['server,unknown'], 'SORT_UNKNOWN_KEY'],
      [['web'], 'SORT_UNKNOWN_KEY'],
      [['server', 'railway.production'], 'SORT_UNKNOWN_SUFFIX'],
    ] as const) {
      const result = await sortCommand(root, 'env:sort', [...args]);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, code);
      assert.deepEqual(await snapshot(root), original);
    }
    const sorted = await sortCommand(root, 'env:sort', ['railway-production'], server);
    assert.equal(sorted.status, 0, sorted.stderr);
    const result = JSON.parse(sorted.stdout);
    assert.equal(result.count, 1);
    assert.equal(path.basename(result.results[0].filePath), '.env.railway.production');
    assert.ok((await readFile(path.join(server, '.env.railway.production'), 'utf8')).includes('# Provider template railway.production'));
    for (const [file, content] of original) {
      if (content !== null && file !== 'packages/server/.env.railway.production') {
        assert.equal(await readFile(path.join(root, String(file)), 'utf8'), content);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native batch sort skips missing private files without creating files or sync state', async () => {
  const root = await fixture();
  try {
    for (const suffix of ['', '.local', ...lanes.map(lane => `.${lane}`)]) {
      await rm(path.join(root, `packages/server/.env${suffix}`));
    }
    const original = await snapshot(root);
    for (const script of ['env:sort:check', 'env:sort'] as const) {
      const result = await sortCommand(root, script);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).missingCount, 5);
      assert.equal(JSON.parse(result.stdout).count, 0);
      assert.deepEqual(await snapshot(root), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native sort check reports template conflicts without changing local values or cached state', async () => {
  const root = await fixture();
  const file = path.join(root, 'packages/server/.env');
  const template = path.join(root, 'packages/server/.env.example');
  try {
    await writeFile(file, 'VALUE=original\n');
    await writeFile(template, 'VALUE=original\n');
    const baseline = await sortCommand(root, 'env:sort', ['server']);
    assert.equal(baseline.status, 0, baseline.stderr);
    await writeFile(file, 'VALUE=local-edit\n');
    await writeFile(template, 'VALUE=new-default\n');
    const original = await snapshot(root);
    const check = await sortCommand(root, 'env:sort:check', ['server']);
    assert.equal(check.status, 1, check.stderr);
    const result = JSON.parse(check.stdout);
    assert.equal(result.results[0].status, 'conflict');
    assert.ok(result.results[0].conflicts.some((conflict: { key: string }) => conflict.key === 'VALUE'));
    assert.deepEqual(await snapshot(root), original);
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
