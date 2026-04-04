import type { KeywordVector, SimilarityEdge, SimilarityLookup, TripletQuery } from './types.js';

export const LATENT_DIM = 64;
const DEFAULT_EDGE_NEIGHBORS = 8;

type IndexedVector = {
  index: number;
  vector: KeywordVector;
  gx: number;
  gy: number;
};

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

export function keywordVectorsToSimilarityLookup(
  vectors: KeywordVector[],
): SimilarityLookup {
  const byId = new Map<string, KeywordVector>();
  for (const vector of vectors) {
    byId.set(vector.keywordId, vector);
  }

  // Keep a bounded cache to avoid repeated distance calculation for hot pairs.
  const cache = new Map<string, number>();
  const MAX_CACHE_SIZE = 50_000;

  return {
    getPairSimilarity(leftKeywordId: string, rightKeywordId: string): number | undefined {
      if (leftKeywordId === rightKeywordId) return 1;
      const left = byId.get(leftKeywordId);
      const right = byId.get(rightKeywordId);
      if (!left || !right) return undefined;

      const key = leftKeywordId < rightKeywordId
        ? `${leftKeywordId}|${rightKeywordId}`
        : `${rightKeywordId}|${leftKeywordId}`;

      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const similarity = keywordSimilarity(left, right);
      if (cache.size >= MAX_CACHE_SIZE) {
        cache.clear();
      }
      cache.set(key, similarity);
      return similarity;
    },
  };
}

export function keywordVectorsToSimilarityEdges(
  vectors: KeywordVector[],
): SimilarityEdge[] {
  if (vectors.length <= 1) return [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const vector of vectors) {
    if (vector.x < minX) minX = vector.x;
    if (vector.y < minY) minY = vector.y;
    if (vector.x > maxX) maxX = vector.x;
    if (vector.y > maxY) maxY = vector.y;
  }

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const area = spanX * spanY;
  const avgPerCell = Math.max(DEFAULT_EDGE_NEIGHBORS * 2, 8);
  const cellSize = Math.sqrt(area * avgPerCell / vectors.length);

  const grid = new Map<string, IndexedVector[]>();
  const indexed: IndexedVector[] = new Array(vectors.length);
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    const gx = Math.floor((vector.x - minX) / cellSize);
    const gy = Math.floor((vector.y - minY) / cellSize);
    const item: IndexedVector = { index: i, vector, gx, gy };
    indexed[i] = item;
    const key = `${gx}|${gy}`;
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grid.set(key, [item]);
    }
  }

  const edgeMap = new Map<string, SimilarityEdge>();

  for (const node of indexed) {
    const candidates: IndexedVector[] = [];
    const seen = new Set<number>();

    for (let radius = 0; radius <= 3; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const bucket = grid.get(`${node.gx + dx}|${node.gy + dy}`);
          if (!bucket) continue;
          for (const candidate of bucket) {
            if (candidate.index === node.index || seen.has(candidate.index)) continue;
            seen.add(candidate.index);
            candidates.push(candidate);
          }
        }
      }
      if (candidates.length >= DEFAULT_EDGE_NEIGHBORS * 3) break;
    }

    if (candidates.length === 0) continue;

    candidates
      .sort((a, b) => {
        const dax = a.vector.x - node.vector.x;
        const day = a.vector.y - node.vector.y;
        const dbx = b.vector.x - node.vector.x;
        const dby = b.vector.y - node.vector.y;
        return (dax * dax + day * day) - (dbx * dbx + dby * dby);
      });

    const limit = Math.min(DEFAULT_EDGE_NEIGHBORS, candidates.length);
    for (let i = 0; i < limit; i++) {
      const target = candidates[i].vector;
      const source = node.vector;
      const left = source.keywordId < target.keywordId ? source.keywordId : target.keywordId;
      const right = source.keywordId < target.keywordId ? target.keywordId : source.keywordId;
      const key = `${left}|${right}`;
      if (edgeMap.has(key)) continue;
      edgeMap.set(key, {
        sourceId: left,
        targetId: right,
        weight: keywordSimilarity(source, target),
      });
    }
  }

  return [...edgeMap.values()];
}

/**
 * Legacy JS heuristic triplet recommender.
 *
 * Keep for tests/fixtures only; production recommendation must come from Rust
 * engine (`recommend_triplet`) via web/server embedding adapters.
 */
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

  const targetSim = simMap.get(bestKey) ?? 0;
  let bestNegativeId: string | null = null;
  let bestNegativeScore = Infinity;

  for (const candidate of vectors) {
    const candidateId = candidate.keywordId;
    if (candidateId === anchorId || candidateId === positiveId) continue;

    const pairKey = anchorId < candidateId
      ? `${anchorId}|${candidateId}`
      : `${candidateId}|${anchorId}`;
    const sim = simMap.get(pairKey) ?? 0;

    // Hard negative: similarity to anchor close to the anchor-positive similarity.
    const score = Math.abs(sim - targetSim);
    if (score < bestNegativeScore) {
      bestNegativeScore = score;
      bestNegativeId = candidateId;
    }
  }

  if (!bestNegativeId) return null;
  const negativeId = bestNegativeId;
  return { anchorId, positiveId, negativeId };
}
