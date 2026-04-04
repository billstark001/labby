/**
 * Keyword similarity engine using triplet-loss gradient descent.
 *
 * Each keyword is represented as a hidden 2D unit vector. Similarity between
 * two keywords is derived from their Euclidean distance mapped to [0, 1].
 *
 * Triplet loss: given (anchor A, positive C, negative B), we want
 *   dist(A, C) + margin < dist(A, B)
 * The gradient step moves A and C closer, and A and B farther apart.
 */

import type { TripletQuery } from './types.js';

/** 2D position in the hidden embedding space. */
export interface EmbeddingPoint {
  x: number;
  y: number;
}

/** Map from keyword ID to its current 2D embedding. */
export type EmbeddingMap = Map<string, EmbeddingPoint>;

const MARGIN = 0.2;
const LEARNING_RATE = 0.05;
const ITERATIONS = 200;

/** Euclidean distance between two points. */
function dist(a: EmbeddingPoint, b: EmbeddingPoint): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Create a random embedding for a new keyword. */
export function randomEmbedding(): EmbeddingPoint {
  return {
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
  };
}

/** Initialize embeddings for a list of keyword IDs. */
export function initEmbeddings(keywordIds: string[]): EmbeddingMap {
  const map: EmbeddingMap = new Map();
  for (const id of keywordIds) {
    map.set(id, randomEmbedding());
  }
  return map;
}

/**
 * Apply one triplet-loss gradient step.
 *
 * @param embeddings - mutable embedding map (modified in-place)
 * @param query      - the triplet comparison (anchor, positive, negative)
 * @param lr         - learning rate (default LEARNING_RATE)
 */
export function applyTripletStep(
  embeddings: EmbeddingMap,
  query: TripletQuery,
  lr = LEARNING_RATE,
): void {
  const a = embeddings.get(query.anchorId);
  const pos = embeddings.get(query.positiveId);
  const neg = embeddings.get(query.negativeId);
  if (!a || !pos || !neg) return;

  const dPos = dist(a, pos);
  const dNeg = dist(a, neg);
  const loss = Math.max(0, dPos - dNeg + MARGIN);
  if (loss === 0) return;

  // Gradient w.r.t. anchor from positive pair (pull closer)
  if (dPos > 1e-8) {
    const gxPos = lr * (a.x - pos.x) / dPos;
    const gyPos = lr * (a.y - pos.y) / dPos;
    a.x -= gxPos;
    a.y -= gyPos;
    pos.x += gxPos;
    pos.y += gyPos;
  }
  // Gradient w.r.t. anchor from negative pair (push farther)
  if (dNeg > 1e-8) {
    const gxNeg = lr * (a.x - neg.x) / dNeg;
    const gyNeg = lr * (a.y - neg.y) / dNeg;
    a.x += gxNeg;
    a.y += gyNeg;
    neg.x -= gxNeg;
    neg.y -= gyNeg;
  }
}

/**
 * Attract a group of keywords toward each other.
 * Simulates the "pull closer" batch interaction from the D3 brush selection.
 */
export function attractKeywords(
  embeddings: EmbeddingMap,
  keywordIds: string[],
  strength = 0.1,
): EmbeddingMap {
  const result = cloneEmbeddings(embeddings);
  for (let i = 0; i < keywordIds.length; i++) {
    for (let j = i + 1; j < keywordIds.length; j++) {
      const a = result.get(keywordIds[i]);
      const b = result.get(keywordIds[j]);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      a.x += dx * strength;
      a.y += dy * strength;
      b.x -= dx * strength;
      b.y -= dy * strength;
    }
  }
  return result;
}

/**
 * Repel a group of keywords away from each other.
 */
export function repelKeywords(
  embeddings: EmbeddingMap,
  keywordIds: string[],
  strength = 0.1,
): EmbeddingMap {
  const result = cloneEmbeddings(embeddings);
  for (let i = 0; i < keywordIds.length; i++) {
    for (let j = i + 1; j < keywordIds.length; j++) {
      const a = result.get(keywordIds[i]);
      const b = result.get(keywordIds[j]);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      a.x -= dx * strength;
      a.y -= dy * strength;
      b.x += dx * strength;
      b.y += dy * strength;
    }
  }
  return result;
}

/**
 * Convert the embedding map to a pairwise similarity map.
 * Similarity = 1 / (1 + dist(a, b))  mapped to (0, 1].
 *
 * @returns Map keyed by `${idA}|${idB}` (sorted IDs for deduplication).
 */
export function embeddingsToSimilarities(
  embeddings: EmbeddingMap,
): Map<string, number> {
  const ids = [...embeddings.keys()];
  const result = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = embeddings.get(ids[i])!;
      const b = embeddings.get(ids[j])!;
      const d = dist(a, b);
      const similarity = 1 / (1 + d);
      const [left, right] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      const key = `${left}|${right}`;
      result.set(key, similarity);
    }
  }
  return result;
}

/** Deep-clone an embedding map so algorithms can be pure. */
export function cloneEmbeddings(map: EmbeddingMap): EmbeddingMap {
  const clone: EmbeddingMap = new Map();
  for (const [id, pt] of map) {
    clone.set(id, { x: pt.x, y: pt.y });
  }
  return clone;
}

/**
 * Generate the next triplet query for the user to answer.
 * Picks the pair with the most uncertain similarity (closest to 0.5)
 * as the anchor–positive pair, then picks a random negative.
 *
 * @param recentPairs - optional set of pair keys (`"idA|idB"`, sorted) to skip,
 *   so the same question is not immediately repeated.
 */
export function nextTripletQuery(
  embeddings: EmbeddingMap,
  keywordIds: string[],
  recentPairs?: Set<string>,
): TripletQuery | null {
  if (keywordIds.length < 3) return null;
  const similarities = embeddingsToSimilarities(embeddings);
  // Find the pair closest to similarity = 0.5 (most uncertain), skipping recent ones.
  let bestKey = '';
  let bestDiff = Infinity;
  for (const [key, sim] of similarities) {
    if (recentPairs?.has(key)) continue;
    const diff = Math.abs(sim - 0.5);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = key;
    }
  }
  // Fall back to any pair if all were excluded
  if (!bestKey) {
    for (const [key, sim] of similarities) {
      const diff = Math.abs(sim - 0.5);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestKey = key;
      }
    }
  }
  if (!bestKey) return null;
  const [anchorId, positiveId] = bestKey.split('|');
  // Pick a random negative that is different
  const others = keywordIds.filter(id => id !== anchorId && id !== positiveId);
  if (others.length === 0) return null;
  const negativeId = others[Math.floor(Math.random() * others.length)];
  return { anchorId, positiveId, negativeId };
}

/**
 * Run multiple triplet gradient steps to converge the embedding.
 * Used after loading saved triplet answers in bulk.
 */
export function runTripletBatch(
  embeddings: EmbeddingMap,
  queries: TripletQuery[],
  iterations = ITERATIONS,
): EmbeddingMap {
  const result = cloneEmbeddings(embeddings);
  for (let i = 0; i < iterations; i++) {
    for (const q of queries) {
      applyTripletStep(result, q);
    }
  }
  return result;
}
