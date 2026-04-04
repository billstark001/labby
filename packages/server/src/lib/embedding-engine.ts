import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

type NativeEngineLike = {
  hydrate(data: Float32Array, nNodes: number): void;
  updateTriplet(idA: number, idB: number, idC: number, margin: number, learningRate: number): number;
  flushDirtyNodes(): Buffer | Uint8Array;
};

interface DirtyNode {
  id: number;
  coords64d: number[];
  coords2d: [number, number];
}

const LATENT_DIM = 64;

function parseDirtyBuffer(buffer: Buffer | Uint8Array): DirtyNode[] {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 4) return [];
  const count = bytes.readUInt32LE(0);
  const entryBytes = 4 + LATENT_DIM * 4 + 2 * 4;
  const nodes: DirtyNode[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (offset + entryBytes > bytes.length) break;
    const id = bytes.readUInt32LE(offset);
    offset += 4;
    const coords64d = new Array<number>(LATENT_DIM);
    for (let j = 0; j < LATENT_DIM; j++) {
      coords64d[j] = bytes.readFloatLE(offset);
      offset += 4;
    }
    const x = bytes.readFloatLE(offset);
    offset += 4;
    const y = bytes.readFloatLE(offset);
    offset += 4;
    nodes.push({ id, coords64d, coords2d: [x, y] });
  }
  return nodes;
}

async function loadNapiEngine(capacity: number): Promise<NativeEngineLike> {
  const req = createRequire(import.meta.url);
  const napiPath = process.env.LABBY_CORE_NAPI_PATH
    ?? path.resolve(process.cwd(), 'packages/core/native/dist/node/labby_core.node');
  const mod = req(napiPath) as { JsEmbeddingEngine?: new (value: number) => NativeEngineLike };
  if (!mod.JsEmbeddingEngine) {
    throw new Error(`Invalid napi module exports: ${napiPath}`);
  }
  return new mod.JsEmbeddingEngine(capacity);
}

async function loadWasmEngine(capacity: number): Promise<NativeEngineLike> {
  const wasmEntryPath = process.env.LABBY_CORE_WASM_NODE_PATH
    ?? path.resolve(process.cwd(), 'packages/core/native/dist/wasm-node/labby_core.js');
  const mod = await import(pathToFileURL(wasmEntryPath).href) as {
    default?: (input?: string | URL | Request) => Promise<unknown>;
    WasmEmbeddingEngine?: new (value: number) => NativeEngineLike;
  };

  if (typeof mod.default === 'function') {
    await mod.default();
  }
  if (!mod.WasmEmbeddingEngine) {
    throw new Error(`Invalid wasm module exports: ${wasmEntryPath}`);
  }
  return new mod.WasmEmbeddingEngine(capacity);
}

export class EmbeddingEngineAdapter {
  private readonly engine: NativeEngineLike;

  private constructor(engine: NativeEngineLike) {
    this.engine = engine;
  }

  static async create(capacity = 1024): Promise<EmbeddingEngineAdapter> {
    try {
      return new EmbeddingEngineAdapter(await loadNapiEngine(capacity));
    } catch (napiErr) {
      try {
        return new EmbeddingEngineAdapter(await loadWasmEngine(capacity));
      } catch (wasmErr) {
        const reason = [
          `Failed to load Rust engine via napi: ${String(napiErr)}`,
          `Failed to load Rust engine via wasm: ${String(wasmErr)}`,
        ].join('\n');
        throw new Error(reason);
      }
    }
  }

  hydrate(data: Float32Array, nNodes: number): void {
    this.engine.hydrate(data, nNodes);
  }

  updateTriplet(idA: number, idB: number, idC: number, margin: number, learningRate: number): number {
    return this.engine.updateTriplet(idA, idB, idC, margin, learningRate);
  }

  flushDirtyNodes(): DirtyNode[] {
    return parseDirtyBuffer(this.engine.flushDirtyNodes());
  }
}
