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

/**
 * @deprecated Use `keywordVectorsToSimilarityLookup` instead for better performance with large vector sets.
 * @param vectors 
 * @returns 
 */
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

/**
 * Calculates the similarity between two sets of keywords using the provided similarity lookup.
 * For each keyword in `aKeywords`, it finds the best matching keyword in `bKeywords` and averages the best matches.
 * @param aKeywords - The first set of keywords.
 * @param bKeywords - The second set of keywords.
 * @param sim - The similarity lookup to use for calculating pairwise similarities.
 * @returns The average similarity between the two sets of keywords.
 */
export function getPersonSimilarity(
  aKeywords: string[],
  bKeywords: string[],
  sim: SimilarityLookup,
): number {
  if (!aKeywords?.length || !bKeywords?.length) return 0;

  const bestForA = new Array(aKeywords.length).fill(0);
  const bestForB = new Array(bKeywords.length).fill(0);

  for (let i = 0; i < aKeywords.length; i++) {
    for (let j = 0; j < bKeywords.length; j++) {
      const w =
        aKeywords[i] === bKeywords[j]
          ? 1
          : (sim.getPairSimilarity(aKeywords[i], bKeywords[j]) ?? 0);

      if (w > bestForA[i]) bestForA[i] = w;
      if (w > bestForB[j]) bestForB[j] = w;
    }
  }

  const sumA = bestForA.reduce((s, v) => s + v, 0);
  const sumB = bestForB.reduce((s, v) => s + v, 0);

  return (sumA / aKeywords.length + sumB / bKeywords.length) / 2;
}