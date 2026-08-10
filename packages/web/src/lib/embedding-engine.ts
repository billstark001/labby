import { PortableEmbeddingEngine } from '@labby/core';
import type { EmbeddingDirtyNode, IterativeUpdateOptions, KeywordVector, SupervisionQuery, TripletQuery } from '@labby/core';
import * as api from '@/api-server/embedding-engine';
import { isServerDeployment } from '@/lib/runtime';

const DIMENSIONS = 64;
const LOCAL_NODE_LIMIT = 1_000;
let enginePromise: Promise<PortableEmbeddingEngine> | null = null;
let indexById = new Map<string, number>();
let orderedIds: string[] = [];

function sameIds(ids: string[]): boolean {
  return ids.length === orderedIds.length && ids.every((id, index) => id === orderedIds[index]);
}

async function hydrate(vectors: KeywordVector[]): Promise<{ engine: PortableEmbeddingEngine; ordered: KeywordVector[] }> {
  if (vectors.length > LOCAL_NODE_LIMIT) throw new Error(`frontend-only mode supports at most ${LOCAL_NODE_LIMIT} vectors`);
  enginePromise ??= PortableEmbeddingEngine.create(Math.max(16, vectors.length));
  const engine = await enginePromise;
  const ordered = [...vectors].sort((left, right) => left.keywordId.localeCompare(right.keywordId));
  const ids = ordered.map((item) => item.keywordId);
  if (!sameIds(ids)) {
    const flat = new Float32Array(ordered.length * DIMENSIONS);
    ordered.forEach((item, row) => {
      for (let dimension = 0; dimension < DIMENSIONS; dimension += 1) {
        flat[row * DIMENSIONS + dimension] = item.vector64[dimension] ?? 0;
      }
    });
    engine.hydrate(flat, ordered.length);
    orderedIds = ids;
    indexById = new Map(ids.map((id, index) => [id, index]));
  }
  return { engine, ordered };
}

function vectorsFromDirty(nodes: EmbeddingDirtyNode[], ordered: KeywordVector[]): KeywordVector[] {
  const updatedAt = Date.now();
  return nodes.flatMap((node) => {
    const keywordId = ordered[node.id]?.keywordId;
    return keywordId ? [{ keywordId, vector64: node.coords64d, x: node.coords2d[0], y: node.coords2d[1], updatedAt }] : [];
  });
}

export async function recommendTriplet(vectors: KeywordVector[], recentPairKeys: readonly string[]): Promise<TripletQuery | null> {
  if (isServerDeployment) return api.recommendTriplet(recentPairKeys);
  const { engine, ordered } = await hydrate(vectors);
  const excluded: number[] = [];
  for (const key of recentPairKeys) {
    const [leftId, rightId] = key.split('|');
    const left = leftId ? indexById.get(leftId) : undefined;
    const right = rightId ? indexById.get(rightId) : undefined;
    if (left !== undefined && right !== undefined) excluded.push(left, right);
  }
  const result = engine.recommendTriplet(Uint32Array.from(excluded));
  if (!result) return null;
  const anchorId = ordered[result[0]]?.keywordId;
  const positiveId = ordered[result[1]]?.keywordId;
  const negativeId = ordered[result[2]]?.keywordId;
  return anchorId && positiveId && negativeId ? { anchorId, positiveId, negativeId } : null;
}

export async function applyTriplet(
  vectors: KeywordVector[], query: TripletQuery, margin = 0.2, options?: IterativeUpdateOptions,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (isServerDeployment) return api.applyTriplet(query, margin, options);
  const { engine, ordered } = await hydrate(vectors);
  const anchor = indexById.get(query.anchorId);
  const positive = indexById.get(query.positiveId);
  const negative = indexById.get(query.negativeId);
  if (anchor === undefined || positive === undefined || negative === undefined) throw new Error('triplet keyword ids not found');
  const loss = engine.updateTriplet(anchor, positive, negative, margin, options);
  return { loss, updatedVectors: vectorsFromDirty(engine.flushDirtyNodes(), ordered) };
}

export async function applyPairUpdate(
  vectors: KeywordVector[], leftId: string, rightId: string, targetDistance: number, options?: IterativeUpdateOptions,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (isServerDeployment) return api.applyPairUpdate(leftId, rightId, targetDistance, options);
  const { engine, ordered } = await hydrate(vectors);
  const left = indexById.get(leftId);
  const right = indexById.get(rightId);
  if (left === undefined || right === undefined) throw new Error('pair keyword ids not found');
  const loss = engine.updatePair(left, right, targetDistance, options);
  return { loss, updatedVectors: vectorsFromDirty(engine.flushDirtyNodes(), ordered) };
}

export async function applySupervision(
  vectors: KeywordVector[], query: SupervisionQuery,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  if (query.kind === 'pair') {
    return applyPairUpdate(vectors, query.leftId, query.rightId, query.targetDistance, query.updateOptions);
  }
  if (isServerDeployment) return api.applySupervision(query);
  const { engine, ordered } = await hydrate(vectors);
  const anchor = indexById.get(query.anchorId);
  if (anchor === undefined) throw new Error('ranked anchor id not found');
  const ranked = query.orderedIds.map((id) => indexById.get(id)).filter((id): id is number => id !== undefined);
  const triplets: number[] = [];
  for (let index = 0; index + 1 < ranked.length; index += 1) triplets.push(anchor, ranked[index]!, ranked[index + 1]!);
  if (triplets.length === 0) return { loss: 0, updatedVectors: [] };
  const dirty = engine.updateTripletsBatchFlush(Uint32Array.from(triplets), query.margin ?? 0.2, query.updateOptions);
  return { loss: 0, updatedVectors: vectorsFromDirty(dirty, ordered) };
}
