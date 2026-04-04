import type { KeywordVector, SimilarityEdge, TripletQuery } from './types.js';

export const LATENT_DIM = 64;

function l2Distance(a: readonly number[], b: readonly number[]): number {
  const dim = Math.min(a.length, b.length, LATENT_DIM);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function randomVector64(): number[] {
  const vec = new Array<number>(LATENT_DIM);
  for (let i = 0; i < LATENT_DIM; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

export function initKeywordVectors(keywordIds: string[]): KeywordVector[] {
  const now = Date.now();
  return keywordIds.map((keywordId) => {
    const vector64 = randomVector64();
    return {
      keywordId,
      vector64,
      x: vector64[0] ?? 0,
      y: vector64[1] ?? 0,
      updatedAt: now,
    };
  });
}

export function keywordSimilarity(a: KeywordVector, b: KeywordVector): number {
  const d = l2Distance(a.vector64, b.vector64);
  return 1 / (1 + d);
}

export function keywordVectorsToSimilarityMap(
  vectors: KeywordVector[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const a = vectors[i];
      const b = vectors[j];
      const [left, right] = a.keywordId < b.keywordId
        ? [a.keywordId, b.keywordId]
        : [b.keywordId, a.keywordId];
      result.set(`${left}|${right}`, keywordSimilarity(a, b));
    }
  }
  return result;
}

export function keywordVectorsToSimilarityEdges(
  vectors: KeywordVector[],
): SimilarityEdge[] {
  const edges: SimilarityEdge[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const a = vectors[i];
      const b = vectors[j];
      edges.push({
        sourceId: a.keywordId,
        targetId: b.keywordId,
        weight: keywordSimilarity(a, b),
      });
    }
  }
  return edges;
}

export function nextTripletQueryFromKeywordVectors(
  vectors: KeywordVector[],
  recentPairs?: Set<string>,
): TripletQuery | null {
  if (vectors.length < 3) return null;
  const simMap = keywordVectorsToSimilarityMap(vectors);
  let bestKey = '';
  let bestDiff = Infinity;
  for (const [key, sim] of simMap) {
    if (recentPairs?.has(key)) continue;
    const diff = Math.abs(sim - 0.5);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = key;
    }
  }
  if (!bestKey) {
    for (const [key, sim] of simMap) {
      const diff = Math.abs(sim - 0.5);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestKey = key;
      }
    }
  }
  if (!bestKey) return null;
  const [anchorId, positiveId] = bestKey.split('|');
  if (!anchorId || !positiveId) return null;
  const others = vectors
    .map(v => v.keywordId)
    .filter(id => id !== anchorId && id !== positiveId);
  if (others.length === 0) return null;
  const negativeId = others[Math.floor(Math.random() * others.length)];
  return { anchorId, positiveId, negativeId };
}
