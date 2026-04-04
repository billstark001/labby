import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');
const distNodeDir = path.join(nativeDir, 'dist', 'node');
const distWasmWebDir = path.join(nativeDir, 'dist', 'wasm-web');
const distWasmNodeDir = path.join(nativeDir, 'dist', 'wasm-node');

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? -1}`));
    });
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyNodeAddon() {
  await ensureDir(distNodeDir);
  const candidates = [
    path.join(nativeDir, 'target', 'release', 'liblabby_core.dylib'),
    path.join(nativeDir, 'target', 'release', 'liblabby_core.so'),
    path.join(nativeDir, 'target', 'release', 'labby_core.dll'),
  ];
  const src = await findFirstExisting(candidates);
  if (!src) {
    throw new Error('Rust node artifact not found after cargo build');
  }
  const target = path.join(distNodeDir, 'labby_core.node');
  await fs.copyFile(src, target);
}

async function findFirstExisting(paths) {
  for (const p of paths) {
    try {
      await fs.stat(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function buildNode() {
  await run('cargo', ['build', '--release', '--features', 'node'], nativeDir);
  await copyNodeAddon();
}

async function buildWasm(targetName, outDir) {
  await ensureDir(outDir);
  await run('wasm-pack', [
    'build',
    nativeDir,
    '--target',
    targetName,
    '--release',
    '--out-dir',
    outDir,
    '--out-name',
    'labby_core',
    '--',
    '--features',
    'wasm',
  ], root);
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  if (!['all', 'node', 'wasm-web', 'wasm-node'].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }

  if (mode === 'all' || mode === 'node') {
    await buildNode();
  }
  if (mode === 'all' || mode === 'wasm-web') {
    await buildWasm('web', distWasmWebDir);
  }
  if (mode === 'all' || mode === 'wasm-node') {
    await buildWasm('nodejs', distWasmNodeDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
