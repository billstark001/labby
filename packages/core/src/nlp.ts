import type { KeywordVector, ProductGeometry, SimilarityLookup } from './types.js';
import { activeDimensions, DEFAULT_GEOMETRY, productDistance, projectEmbedding } from './embedding/geometry.js';

export function initKeywordVectors(keywordIds: string[], geometry: ProductGeometry = DEFAULT_GEOMETRY): KeywordVector[] {
  const dimensions = activeDimensions(geometry);
  const now = Date.now();
  return keywordIds.map((keywordId) => {
    const embedding = Array.from({ length: dimensions }, () => (Math.random() * 2 - 1) / Math.sqrt(dimensions));
    const [x, y] = projectEmbedding(embedding, geometry);
    return {
      keywordId,
      embedding,
      geometry: { ...geometry },
      x,
      y,
      updatedAt: now,
    };
  });
}

export function keywordSimilarity(a: KeywordVector, b: KeywordVector): number {
  const d = productDistance(a, b);
  return 1 / (1 + d);
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
