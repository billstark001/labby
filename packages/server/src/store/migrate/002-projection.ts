import type { KeywordVector } from '@labby/core';

/** One-way database migration only. Fixed geometry makes this migration reproducible. */
export function migrateEuclideanVector(value: {
  keywordId: string;
  vector64: number[];
  updatedAt: number;
}): KeywordVector {
  if (
    !value.keywordId ||
    !Array.isArray(value.vector64) ||
    value.vector64.length !== 64 ||
    !value.vector64.every(Number.isFinite)
  ) {
    throw new Error('Cannot migrate malformed Euclidean keyword vector');
  }
  const geometry = { hyperbolicDimensions: 8, euclideanDimensions: 8 };
  // Fixed signed random projection compresses old relationships approximately.
  // The source row is archived by the database migration before conversion.
  const embedding = Array.from({ length: 16 }, (_, k) =>
    value.vector64.reduce((s, v, i) => {
      let hash = Math.imul(i + 1, 0x45d9f3b) ^ Math.imul(k + 71, 0x27d4eb2d);
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
      return s + (v * ((hash >>> 8) & 1 ? 1 : -1)) / 8;
    }, 0),
  );
  const norm = Math.hypot(...embedding);
  if (norm > 2) for (let k = 0; k < embedding.length; k++) embedding[k] *= 2 / norm;
  // Frozen with this migration, independent of runtime geometry changes.
  const time = Math.sqrt(1 + embedding.slice(0, 8).reduce((sum, value) => sum + value * value, 0));
  const x = embedding[0]! / (time + 1);
  const y = embedding[1]! / (time + 1);
  return {
    keywordId: value.keywordId,
    embedding,
    geometry,
    x,
    y,
    updatedAt: value.updatedAt,
  };
}
