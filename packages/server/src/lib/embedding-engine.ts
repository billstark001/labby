import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { IterativeUpdateOptions } from '@labby/core';

type NativeEngineLike = {
  hydrate(data: Float32Array, nNodes: number): void;
  recommendTriplet(excludedPairs: Uint32Array): Uint32Array | number[];
  updateTriplet(
    idA: number,
    idB: number,
    idC: number,
    margin: number,
    options?: IterativeUpdateOptions,
  ): number;
  updatePair(
    idA: number,
    idB: number,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): number;
  updateTripletsBatchFlush(
    triplets: Uint32Array,
    margin: number,
    options?: IterativeUpdateOptions,
  ): Buffer | Uint8Array;
  updatePairsBatchFlush(
    pairs: Uint32Array,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): Buffer | Uint8Array;
  flushDirtyNodes(): Buffer | Uint8Array;
};

type RawEngineLike = Record<string, unknown>;

interface DirtyNode {
  id: number;
  coords64d: number[];
  coords2d: [number, number];
}

const LATENT_DIM = 64;
const DEFAULT_ITERATIVE_UPDATE_OPTIONS: Required<IterativeUpdateOptions> = {
  learningRate: 0.05,
  minIters: 2,
  maxIters: 16,
  stabilityWindow: 3,
  stabilityTolerance: 1e-3,
};

function resolveUpdateOptions(options?: IterativeUpdateOptions): IterativeUpdateOptions {
  return {
    learningRate: options?.learningRate ?? DEFAULT_ITERATIVE_UPDATE_OPTIONS.learningRate,
    minIters: options?.minIters ?? DEFAULT_ITERATIVE_UPDATE_OPTIONS.minIters,
    maxIters: options?.maxIters ?? DEFAULT_ITERATIVE_UPDATE_OPTIONS.maxIters,
    stabilityWindow: options?.stabilityWindow ?? DEFAULT_ITERATIVE_UPDATE_OPTIONS.stabilityWindow,
    stabilityTolerance: options?.stabilityTolerance ?? DEFAULT_ITERATIVE_UPDATE_OPTIONS.stabilityTolerance,
  };
}

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

function pickMethod<T extends (...args: any[]) => any>(
  engine: RawEngineLike,
  names: string[],
): T | null {
  for (const name of names) {
    const value = engine[name];
    if (typeof value === 'function') {
      return value.bind(engine) as T;
    }
  }
  return null;
}

function normalizeEngineApi(engine: RawEngineLike): NativeEngineLike {
  const hydrate = pickMethod<NativeEngineLike['hydrate']>(engine, ['hydrate']);
  const recommendTriplet = pickMethod<NativeEngineLike['recommendTriplet']>(engine, [
    'recommendTriplet',
    'recommend_triplet',
  ]);
  const updateTriplet = pickMethod<NativeEngineLike['updateTriplet']>(engine, [
    'updateTriplet',
    'update_triplet',
  ]);
  const updatePair = pickMethod<NativeEngineLike['updatePair']>(engine, ['updatePair', 'update_pair']);
  const updateTripletsBatchFlush = pickMethod<NativeEngineLike['updateTripletsBatchFlush']>(engine, [
    'updateTripletsBatchFlush',
    'update_triplets_batch_flush',
  ]);
  const updatePairsBatchFlush = pickMethod<NativeEngineLike['updatePairsBatchFlush']>(engine, [
    'updatePairsBatchFlush',
    'update_pairs_batch_flush',
  ]);
  const flushDirtyNodes = pickMethod<NativeEngineLike['flushDirtyNodes']>(engine, [
    'flushDirtyNodes',
    'flush_dirty_nodes',
  ]);

  if (
    !hydrate
    || !recommendTriplet
    || !updateTriplet
    || !updatePair
    || !updateTripletsBatchFlush
    || !updatePairsBatchFlush
    || !flushDirtyNodes
  ) {
    throw new Error(`Engine API mismatch. Available exports: ${Object.keys(engine).sort().join(', ')}`);
  }

  return {
    hydrate,
    recommendTriplet,
    updateTriplet,
    updatePair,
    updateTripletsBatchFlush,
    updatePairsBatchFlush,
    flushDirtyNodes,
  };
}

async function loadNapiEngine(capacity: number): Promise<NativeEngineLike> {
  const req = createRequire(import.meta.url);
  const napiPath = process.env.LABBY_CORE_NAPI_PATH
    ?? path.resolve(process.cwd(), '../core/native/dist/node/labby_core.node');
  const mod = req(napiPath) as { JsEmbeddingEngine?: new (value: number) => NativeEngineLike };
  if (!mod.JsEmbeddingEngine) {
    throw new Error(`Invalid napi module exports: ${napiPath}`);
  }
  return normalizeEngineApi(new mod.JsEmbeddingEngine(capacity) as RawEngineLike);
}

async function loadWasmEngine(capacity: number): Promise<NativeEngineLike> {
  const wasmEntryPath = process.env.LABBY_CORE_WASM_NODE_PATH
    ?? path.resolve(process.cwd(), '../core/native/dist/wasm-node/labby_core.js');
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
  return normalizeEngineApi(new mod.WasmEmbeddingEngine(capacity) as RawEngineLike);
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

  recommendTriplet(excludedPairs: Uint32Array): [number, number, number] | null {
    const raw = this.engine.recommendTriplet(excludedPairs);
    const values = Array.from(raw as ArrayLike<number>);
    if (values.length < 3) return null;
    return [values[0]!, values[1]!, values[2]!];
  }

  updateTriplet(
    idA: number,
    idB: number,
    idC: number,
    margin: number,
    options?: IterativeUpdateOptions,
  ): number {
    return this.engine.updateTriplet(idA, idB, idC, margin, resolveUpdateOptions(options));
  }

  updatePair(
    idA: number,
    idB: number,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): number {
    return this.engine.updatePair(idA, idB, targetDistance, resolveUpdateOptions(options));
  }

  updateTripletsBatchFlush(
    triplets: Uint32Array,
    margin: number,
    options?: IterativeUpdateOptions,
  ): DirtyNode[] {
    return parseDirtyBuffer(this.engine.updateTripletsBatchFlush(triplets, margin, resolveUpdateOptions(options)));
  }

  updatePairsBatchFlush(
    pairs: Uint32Array,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): DirtyNode[] {
    return parseDirtyBuffer(this.engine.updatePairsBatchFlush(pairs, targetDistance, resolveUpdateOptions(options)));
  }

  flushDirtyNodes(): DirtyNode[] {
    return parseDirtyBuffer(this.engine.flushDirtyNodes());
  }
}
