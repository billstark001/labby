import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const requireFromHere = createRequire(import.meta.url);

describe('Rust artifact direct import from TS', () => {
  test('directly import napi addon when artifact exists', async ({ skip }) => {
    const addonPath = path.resolve(repoRoot, 'core/native/dist/node/labby_core.node');
    if (!fs.existsSync(addonPath)) {
      skip();
      return;
    }

    const mod = requireFromHere(addonPath) as { JsEmbeddingEngine?: new (capacity: number) => object };
    expect(typeof mod.JsEmbeddingEngine).toBe('function');
  });

  test('directly import wasm node wrapper when artifact exists', async ({ skip }) => {
    const wasmEntryPath = path.resolve(repoRoot, 'core/native/dist/wasm-node/labby_core.js');
    if (!fs.existsSync(wasmEntryPath)) {
      skip();
      return;
    }

    const mod = await import(pathToFileURL(wasmEntryPath).href) as {
      default?: (input?: string | URL | Request) => Promise<unknown>;
      WasmEmbeddingEngine?: new (capacity: number) => object;
    };

    if (typeof mod.default === 'function') {
      await mod.default();
    }

    expect(typeof mod.WasmEmbeddingEngine).toBe('function');
  });
});
