import type { KeywordVector, SupervisionQuery, TripletQuery } from '@labby/core';
import initWasm, { WasmEmbeddingEngine } from '../../../core/native/dist/wasm-web/labby_core.js';
import { apiClient } from '@/lib/api';
import { isServerDeployment } from '@/lib/runtime';

const LATENT_DIM = 64;
const FRONTEND_ONLY_MAX_NODES = 1_000;

type WasmEngineLike = {
  hydrate(data: Float32Array, nNodes: number): void;
  recommend_triplet(excludedPairs: Uint32Array): Uint32Array | number[];
  update_triplets_batch_flush(triplets: Uint32Array, margin: number, learningRate: number): Uint8Array;
  update_pairs_batch_flush(pairs: Uint32Array, targetDistance: number, learningRate: number): Uint8Array;
  update_triplet(idA: number, idB: number, idC: number, margin: number, learningRate: number): number;
  update_pair(idA: number, idB: number, targetDistance: number, learningRate: number): number;
  flush_dirty_nodes(): Uint8Array;
};

let enginePromise: Promise<WasmEngineLike> | null = null;
let hydratedIndexById = new Map<string, number>();
let hydratedOrderedIds: string[] = [];

function stableIdCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function loadEngine(): Promise<WasmEngineLike> {
  await initWasm();
  return new WasmEmbeddingEngine(1024) as WasmEngineLike;
}

function ensureFrontendOnlyScale(vectors: KeywordVector[]): void {
  if (vectors.length > FRONTEND_ONLY_MAX_NODES) {
    throw new Error(
      `frontend-only mode supports up to ${FRONTEND_ONLY_MAX_NODES} vectors; ` +
      'for larger datasets, switch deployment mode to server',
    );
  }
}

function sameOrderedIds(nextOrdered: string[]): boolean {
  if (nextOrdered.length !== hydratedOrderedIds.length) return false;
  for (let i = 0; i < nextOrdered.length; i++) {
    if (nextOrdered[i] !== hydratedOrderedIds[i]) return false;
  }
  return true;
}

function buildFlatVectors(ordered: KeywordVector[]): Float32Array {
  const flat = new Float32Array(ordered.length * LATENT_DIM);
  for (let i = 0; i < ordered.length; i++) {
    const vec = ordered[i].vector64;
    for (let j = 0; j < LATENT_DIM; j++) {
      flat[i * LATENT_DIM + j] = vec[j] ?? 0;
    }
  }
  return flat;
}

function ensureHydrated(engine: WasmEngineLike, vectors: KeywordVector[]): KeywordVector[] {
  const ordered = [...vectors].sort((a, b) => stableIdCompare(a.keywordId, b.keywordId));
  const orderedIds = ordered.map((item) => item.keywordId);
  if (sameOrderedIds(orderedIds)) {
    return ordered;
  }

  engine.hydrate(buildFlatVectors(ordered), ordered.length);
  hydratedOrderedIds = orderedIds;
  hydratedIndexById = new Map(orderedIds.map((id, i) => [id, i]));
  return ordered;
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

function parseTripletRecommendation(raw: Uint32Array | number[]): [number, number, number] | null {
  const values = Array.from(raw as ArrayLike<number>);
  if (values.length < 3) return null;
  return [values[0]!, values[1]!, values[2]!];
}

function pairKeysToHydratedPairs(recentPairKeys: readonly string[]): Uint32Array {
  const out: number[] = [];
  for (const key of recentPairKeys) {
    const [leftId, rightId] = key.split('|');
    if (!leftId || !rightId) continue;
    const left = hydratedIndexById.get(leftId);
    const right = hydratedIndexById.get(rightId);
    if (left === undefined || right === undefined) continue;
    out.push(left, right);
  }
  return Uint32Array.from(out);
}

export async function recommendTripletWithWasm(
  vectors: KeywordVector[],
  recentPairKeys: readonly string[],
): Promise<TripletQuery | null> {
  if (isServerDeployment) {
    const response = await apiClient.request<{ query: TripletQuery | null }>('/nlp/recommend-triplet', {
      method: 'POST',
      body: JSON.stringify({
        excludedPairs: [...recentPairKeys],
      }),
    });
    return response.query;
  }

  ensureFrontendOnlyScale(vectors);

  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  const engine = await enginePromise;
  const ordered = ensureHydrated(engine, vectors);
  const recommendation = parseTripletRecommendation(
    engine.recommend_triplet(pairKeysToHydratedPairs(recentPairKeys)),
  );
  if (!recommendation) {
    return null;
  }
  const [anchorIndex, positiveIndex, negativeIndex] = recommendation;
  const anchorId = ordered[anchorIndex]?.keywordId;
  const positiveId = ordered[positiveIndex]?.keywordId;
  const negativeId = ordered[negativeIndex]?.keywordId;
  if (!anchorId || !positiveId || !negativeId) {
    return null;
  }
  return {
    anchorId,
    positiveId,
    negativeId,
  };
}

export async function applyTripletWithWasm(
  vectors: KeywordVector[],
  query: TripletQuery,
  margin = 0.2,
  learningRate = 0.05,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (isServerDeployment) {
    return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/update-similarity', {
      method: 'POST',
      body: JSON.stringify({
        anchorId: query.anchorId,
        positiveId: query.positiveId,
        negativeId: query.negativeId,
        margin,
        learningRate,
      }),
    });
  }

  ensureFrontendOnlyScale(vectors);

  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  const engine = await enginePromise;

  const ordered = ensureHydrated(engine, vectors);

  const a = hydratedIndexById.get(query.anchorId);
  const b = hydratedIndexById.get(query.positiveId);
  const c = hydratedIndexById.get(query.negativeId);
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error('triplet keyword ids not found');
  }

  const loss = engine.update_triplet(a, b, c, margin, learningRate);

  const dirtyBytes = engine.flush_dirty_nodes();

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

export async function applyPairUpdate(
  vectors: KeywordVector[],
  leftId: string,
  rightId: string,
  targetDistance: number,
  learningRate = 0.05,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (isServerDeployment) {
    return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/update-pair', {
      method: 'POST',
      body: JSON.stringify({
        leftId,
        rightId,
        targetDistance,
        learningRate,
      }),
    });
  }

  ensureFrontendOnlyScale(vectors);

  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  const engine = await enginePromise;

  const ordered = ensureHydrated(engine, vectors);
  const a = hydratedIndexById.get(leftId);
  const b = hydratedIndexById.get(rightId);
  if (a === undefined || b === undefined) {
    throw new Error('pair keyword ids not found');
  }

  const loss = engine.update_pair(a, b, targetDistance, learningRate);

  const dirtyBytes = engine.flush_dirty_nodes();
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

export async function applySupervision(
  vectors: KeywordVector[],
  query: SupervisionQuery,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (query.kind === 'pair') {
    return applyPairUpdate(
      vectors,
      query.leftId,
      query.rightId,
      query.targetDistance,
      query.learningRate ?? 0.05,
    );
  }

  if (isServerDeployment) {
    return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/apply-supervision', {
      method: 'POST',
      body: JSON.stringify(query),
    });
  }

  ensureFrontendOnlyScale(vectors);

  if (!enginePromise) {
    enginePromise = loadEngine();
  }
  const engine = await enginePromise;
  const ordered = ensureHydrated(engine, vectors);
  const anchor = hydratedIndexById.get(query.anchorId);
  if (anchor === undefined) {
    throw new Error('ranked anchor id not found');
  }

  const orderedIndices = query.orderedIds
    .map((keywordId) => hydratedIndexById.get(keywordId))
    .filter((value): value is number => value !== undefined);
  if (orderedIndices.length < 2) {
    return { loss: 0, updatedVectors: [] };
  }

  const triplets: number[] = [];
  for (let i = 0; i < orderedIndices.length - 1; i++) {
    const positive = orderedIndices[i];
    const negative = orderedIndices[i + 1];
    if (positive === undefined || negative === undefined) continue;
    triplets.push(anchor, positive, negative);
  }
  if (triplets.length === 0) {
    return { loss: 0, updatedVectors: [] };
  }

  const dirtyBytes = engine.update_triplets_batch_flush(
    Uint32Array.from(triplets),
    query.margin ?? 0.2,
    query.learningRate ?? 0.05,
  );
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

  return { loss: 0, updatedVectors };
}
