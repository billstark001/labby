import type { KeywordVector, TripletQuery } from '@labby/core';
import initWasm, { WasmEmbeddingEngine } from '../../../core/native/dist/wasm-web/labby_core.js';

const LATENT_DIM = 64;

type WasmEngineLike = {
  hydrate(data: Float32Array, nNodes: number): void;
  update_triplet?(idA: number, idB: number, idC: number, margin: number, learningRate: number): number;
  updateTriplet?(idA: number, idB: number, idC: number, margin: number, learningRate: number): number;
  flush_dirty_nodes?(): Uint8Array;
  flushDirtyNodes?(): Uint8Array;
};

let enginePromise: Promise<WasmEngineLike> | null = null;

async function loadEngine(): Promise<WasmEngineLike> {
  await initWasm();
  return new WasmEmbeddingEngine(1024) as WasmEngineLike;
}

function parseDirtyBuffer(buffer: Uint8Array): Array<{ id: number; coords64d: number[]; coords2d: [number, number] }> {
  if (buffer.byteLength < 4) return [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getUint32(0, true);
  const entryBytes = 4 + LATENT_DIM * 4 + 2 * 4;
  const result: Array<{ id: number; coords64d: number[]; coords2d: [number, number] }> = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (offset + entryBytes > buffer.byteLength) break;
    const id = view.getUint32(offset, true);
    offset += 4;
    const coords64d = new Array<number>(LATENT_DIM);
    for (let j = 0; j < LATENT_DIM; j++) {
      coords64d[j] = view.getFloat32(offset, true);
      offset += 4;
    }
    const x = view.getFloat32(offset, true);
    offset += 4;
    const y = view.getFloat32(offset, true);
    offset += 4;
    result.push({ id, coords64d, coords2d: [x, y] });
  }
  return result;
}

export async function applyTripletWithWasm(
  vectors: KeywordVector[],
  query: TripletQuery,
  margin = 0.2,
  learningRate = 0.05,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  const engine = await enginePromise;

  const ordered = [...vectors].sort((a, b) => a.keywordId.localeCompare(b.keywordId));
  const indexById = new Map(ordered.map((v, i) => [v.keywordId, i]));

  const a = indexById.get(query.anchorId);
  const b = indexById.get(query.positiveId);
  const c = indexById.get(query.negativeId);
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error('triplet keyword ids not found');
  }

  const flat = new Float32Array(ordered.length * LATENT_DIM);
  for (let i = 0; i < ordered.length; i++) {
    const vec = ordered[i].vector64;
    for (let j = 0; j < LATENT_DIM; j++) {
      flat[i * LATENT_DIM + j] = vec[j] ?? 0;
    }
  }

  engine.hydrate(flat, ordered.length);
  const loss = engine.updateTriplet
    ? engine.updateTriplet(a, b, c, margin, learningRate)
    : (engine.update_triplet?.(a, b, c, margin, learningRate) ?? 0);

  const dirtyBytes = engine.flushDirtyNodes
    ? engine.flushDirtyNodes()
    : (engine.flush_dirty_nodes?.() ?? new Uint8Array());

  const dirty = parseDirtyBuffer(dirtyBytes);
  const now = Date.now();
  const updatedVectors = dirty
    .map((item) => {
      const keywordId = ordered[item.id]?.keywordId;
      if (!keywordId) return null;
      return {
        keywordId,
        vector64: item.coords64d,
        x: item.coords2d[0],
        y: item.coords2d[1],
        updatedAt: now,
      } satisfies KeywordVector;
    })
    .filter((item): item is KeywordVector => Boolean(item));

  return { loss, updatedVectors };
}
