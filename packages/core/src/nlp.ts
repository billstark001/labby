/**
 * Keyword similarity engine using triplet-loss gradient descent in 64-D space.
 *
 * Each keyword is represented as a 64-dimensional embedding vector.  Similarity
 * between two keywords is the L2-distance-based value mapped to (0, 1]:
 *   similarity(a, b) = 1 / (1 + ||a - b||₂)
 *
 * The 2-D visualization positions (PositionMap) are maintained separately and
 * updated by the same triplet-loss objective to preserve semantic structure.
 *
 * Exported from @labby/algorithm for high-performance compiled usage;
 * the core inline helpers here are pure TypeScript for universal use.
 */

export { DIMS } from '@labby/algorithm';
export type { DirtyResult } from '@labby/algorithm';
export { EmbeddingEngine } from '@labby/algorithm';

import { DIMS } from '@labby/algorithm';
import type { TripletQuery } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 64-dimensional embedding vector. */
export type EmbeddingVector = Float32Array;

/** Map from keyword ID → 64-D embedding vector. */
export type EmbeddingMap = Map<string, EmbeddingVector>;

/** 2-D visualization position. */
export interface EmbeddingPoint {
  x: number;
  y: number;
}

/** Map from keyword ID → 2-D visualization position. */
export type PositionMap = Map<string, EmbeddingPoint>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARGIN = 0.2;
const DEFAULT_LR = 0.05;
const ITERATIONS = 200;

// ---------------------------------------------------------------------------
// Random init
// ---------------------------------------------------------------------------

/** Create a random unit vector in DIMS-D space. */
export function randomEmbedding(): EmbeddingVector {
  const v = new Float32Array(DIMS);
  let normSq = 0;
  for (let i = 0; i < DIMS; i++) {
    const x = Math.random() * 2 - 1;
    v[i] = x;
    normSq += x * x;
  }
  const norm = Math.sqrt(normSq) || 1e-8;
  for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

/** Create a random 2-D position in [-1, 1]². */
export function randomPosition(): EmbeddingPoint {
  return { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
}

// ---------------------------------------------------------------------------
// Init helpers
// ---------------------------------------------------------------------------

/** Initialise a 64-D EmbeddingMap for a list of keyword IDs. */
export function initEmbeddings(keywordIds: string[]): EmbeddingMap {
  const map: EmbeddingMap = new Map();
  for (const id of keywordIds) map.set(id, randomEmbedding());
  return map;
}

/** Initialise a PositionMap with random 2-D positions. */
export function initPositions(keywordIds: string[]): PositionMap {
  const map: PositionMap = new Map();
  for (const id of keywordIds) map.set(id, randomPosition());
  return map;
}

// ---------------------------------------------------------------------------
// Similarity  O(d)
// ---------------------------------------------------------------------------

/**
 * Compute the similarity between two 64-D vectors.
 * Returns 1 / (1 + L2_distance(a, b)), mapped to (0, 1].
 */
export function computeSimilarity(
  a: EmbeddingVector,
  b: EmbeddingVector,
): number {
  let sq = 0;
  for (let i = 0; i < DIMS; i++) {
    const d = a[i] - b[i];
    sq += d * d;
  }
  return 1 / (1 + Math.sqrt(sq));
}

// ---------------------------------------------------------------------------
// k-NN  O(N·d)
// ---------------------------------------------------------------------------

/**
 * Return the k nearest keyword IDs to `id` in embedding space.
 * O(N · d) – avoids the old O(N²) pairwise approach.
 */
export function getKNearest(
  embeddings: EmbeddingMap,
  id: string,
  k: number,
): string[] {
  const anchor = embeddings.get(id);
  if (!anchor) return [];

  const dists: { id: string; sq: number }[] = [];
  for (const [otherId, vec] of embeddings) {
    if (otherId === id) continue;
    let sq = 0;
    for (let i = 0; i < DIMS; i++) {
      const d = anchor[i] - vec[i];
      sq += d * d;
    }
    dists.push({ id: otherId, sq });
  }
  dists.sort((a, b) => a.sq - b.sq);
  return dists.slice(0, k).map(x => x.id);
}

// ---------------------------------------------------------------------------
// Clone helpers
// ---------------------------------------------------------------------------

/** Deep-clone an EmbeddingMap (copies each Float32Array). */
export function cloneEmbeddings(map: EmbeddingMap): EmbeddingMap {
  const clone: EmbeddingMap = new Map();
  for (const [id, vec] of map) clone.set(id, vec.slice());
  return clone;
}

/** Deep-clone a PositionMap. */
export function clonePositions(map: PositionMap): PositionMap {
  const clone: PositionMap = new Map();
  for (const [id, pt] of map) clone.set(id, { x: pt.x, y: pt.y });
  return clone;
}

// ---------------------------------------------------------------------------
// Low-level triplet step helpers (in-place, no map cloning)
// ---------------------------------------------------------------------------

function _sqDist(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIMS; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function _dist(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(_sqDist(a, b));
}

function _dist2d(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

/**
 * Apply one triplet-loss gradient step directly on slices (in-place).
 * This avoids the allocation overhead of temporary EmbeddingEngine instances.
 */
function _tripletStepInPlace(
  aVec: Float32Array, posVec: Float32Array, negVec: Float32Array,
  ap: EmbeddingPoint, pp: EmbeddingPoint, np: EmbeddingPoint,
  lr: number,
): void {
  // 64-D step
  const dPos = _dist(aVec, posVec);
  const dNeg = _dist(aVec, negVec);
  const loss = Math.max(0, dPos - dNeg + MARGIN);
  if (loss > 0) {
    if (dPos > 1e-8) {
      for (let k = 0; k < DIMS; k++) {
        const g = lr * (aVec[k] - posVec[k]) / dPos;
        aVec[k] -= g; posVec[k] += g;
      }
    }
    const dNeg2 = _dist(aVec, negVec);
    if (dNeg2 > 1e-8) {
      for (let k = 0; k < DIMS; k++) {
        const g = lr * (aVec[k] - negVec[k]) / dNeg2;
        aVec[k] += g; negVec[k] -= g;
      }
    }
  }
  // 2-D step
  const d2Pos = _dist2d(ap.x, ap.y, pp.x, pp.y);
  const d2Neg = _dist2d(ap.x, ap.y, np.x, np.y);
  const loss2 = Math.max(0, d2Pos - d2Neg + MARGIN);
  if (loss2 > 0) {
    if (d2Pos > 1e-8) {
      const gx = lr * (ap.x - pp.x) / d2Pos;
      const gy = lr * (ap.y - pp.y) / d2Pos;
      ap.x -= gx; ap.y -= gy; pp.x += gx; pp.y += gy;
    }
    const d2Neg2 = _dist2d(ap.x, ap.y, np.x, np.y);
    if (d2Neg2 > 1e-8) {
      const gx = lr * (ap.x - np.x) / d2Neg2;
      const gy = lr * (ap.y - np.y) / d2Neg2;
      ap.x += gx; ap.y += gy; np.x -= gx; np.y -= gy;
    }
  }
}

// ---------------------------------------------------------------------------
// Triplet step (public, immutable)
// ---------------------------------------------------------------------------

/**
 * Apply one triplet-loss gradient step to both the 64-D embeddings and the
 * 2-D positions.  Returns new cloned maps (pure-function style).
 */
export function applyTripletStep(
  embeddings: EmbeddingMap,
  positions: PositionMap,
  query: TripletQuery,
  lr = DEFAULT_LR,
): { embeddings: EmbeddingMap; positions: PositionMap } {
  const { anchorId, positiveId, negativeId } = query;
  if (
    !embeddings.has(anchorId) || !embeddings.has(positiveId) || !embeddings.has(negativeId) ||
    !positions.has(anchorId) || !positions.has(positiveId) || !positions.has(negativeId)
  ) {
    return { embeddings, positions };
  }

  const newEmbeddings = cloneEmbeddings(embeddings);
  const newPositions = clonePositions(positions);
  _tripletStepInPlace(
    newEmbeddings.get(anchorId)!,
    newEmbeddings.get(positiveId)!,
    newEmbeddings.get(negativeId)!,
    newPositions.get(anchorId)!,
    newPositions.get(positiveId)!,
    newPositions.get(negativeId)!,
    lr,
  );
  return { embeddings: newEmbeddings, positions: newPositions };
}

// ---------------------------------------------------------------------------
// Attract / repel (public, immutable)
// ---------------------------------------------------------------------------

/**
 * Move a group of keywords toward each other in both 64-D and 2-D.
 * Returns new cloned maps.
 */
export function attractKeywords(
  embeddings: EmbeddingMap,
  positions: PositionMap,
  keywordIds: string[],
  strength = 0.1,
): { embeddings: EmbeddingMap; positions: PositionMap } {
  return _adjustGroup(embeddings, positions, keywordIds, strength);
}

/**
 * Move a group of keywords away from each other in both 64-D and 2-D.
 * Returns new cloned maps.
 */
export function repelKeywords(
  embeddings: EmbeddingMap,
  positions: PositionMap,
  keywordIds: string[],
  strength = 0.1,
): { embeddings: EmbeddingMap; positions: PositionMap } {
  return _adjustGroup(embeddings, positions, keywordIds, -strength);
}

function _adjustGroup(
  embeddings: EmbeddingMap,
  positions: PositionMap,
  keywordIds: string[],
  signedStrength: number,
): { embeddings: EmbeddingMap; positions: PositionMap } {
  const present = keywordIds.filter(id => embeddings.has(id) && positions.has(id));
  if (present.length < 2) return { embeddings, positions };

  const newEmbeddings = cloneEmbeddings(embeddings);
  const newPositions = clonePositions(positions);

  for (let ii = 0; ii < present.length; ii++) {
    for (let jj = ii + 1; jj < present.length; jj++) {
      const vi = newEmbeddings.get(present[ii])!;
      const vj = newEmbeddings.get(present[jj])!;
      for (let k = 0; k < DIMS; k++) {
        const dx = vj[k] - vi[k];
        vi[k] += dx * signedStrength;
        vj[k] -= dx * signedStrength;
      }
      const pi = newPositions.get(present[ii])!;
      const pj = newPositions.get(present[jj])!;
      const dx2 = pj.x - pi.x;
      const dy2 = pj.y - pi.y;
      pi.x += dx2 * signedStrength; pi.y += dy2 * signedStrength;
      pj.x -= dx2 * signedStrength; pj.y -= dy2 * signedStrength;
    }
  }
  return { embeddings: newEmbeddings, positions: newPositions };
}

// ---------------------------------------------------------------------------
// Triplet query selection  O(N·d)
// ---------------------------------------------------------------------------

/**
 * Generate the next triplet query for the user to answer.
 *
 * Uses k-NN to find a close positive candidate (O(N·d)) rather than
 * computing all pairwise similarities (old O(N²) approach).
 */
export function nextTripletQuery(
  embeddings: EmbeddingMap,
  keywordIds: string[],
  recentPairs?: Set<string>,
): TripletQuery | null {
  if (keywordIds.length < 3) return null;

  const k = Math.min(10, keywordIds.length - 1);
  let anchorId: string | null = null;
  let positiveId: string | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidateAnchor = keywordIds[Math.floor(Math.random() * keywordIds.length)];
    const neighbours = getKNearest(embeddings, candidateAnchor, k);
    for (const nbId of neighbours) {
      const pairKey = [candidateAnchor, nbId].sort().join('|');
      if (recentPairs?.has(pairKey)) continue;
      anchorId = candidateAnchor;
      positiveId = nbId;
      break;
    }
    if (anchorId) break;
  }

  if (!anchorId || !positiveId) {
    for (let i = 0; i < keywordIds.length && !anchorId; i++) {
      for (let j = i + 1; j < keywordIds.length; j++) {
        anchorId = keywordIds[i];
        positiveId = keywordIds[j];
        break;
      }
    }
  }
  if (!anchorId || !positiveId) return null;

  const others = keywordIds.filter(id => id !== anchorId && id !== positiveId);
  if (others.length === 0) return null;
  return {
    anchorId,
    positiveId,
    negativeId: others[Math.floor(Math.random() * others.length)],
  };
}

// ---------------------------------------------------------------------------
// Batch training
// ---------------------------------------------------------------------------

/**
 * Run multiple triplet gradient steps.
 * Clones once at the start, then applies all steps in-place for efficiency.
 * Returns new maps (immutable from caller's perspective).
 */
export function runTripletBatch(
  embeddings: EmbeddingMap,
  positions: PositionMap,
  queries: TripletQuery[],
  iterations = ITERATIONS,
): { embeddings: EmbeddingMap; positions: PositionMap } {
  // Clone once
  const workEmb = cloneEmbeddings(embeddings);
  const workPos = clonePositions(positions);

  for (let i = 0; i < iterations; i++) {
    for (const q of queries) {
      const aVec = workEmb.get(q.anchorId);
      const pVec = workEmb.get(q.positiveId);
      const nVec = workEmb.get(q.negativeId);
      const ap = workPos.get(q.anchorId);
      const pp = workPos.get(q.positiveId);
      const np = workPos.get(q.negativeId);
      if (!aVec || !pVec || !nVec || !ap || !pp || !np) continue;
      _tripletStepInPlace(aVec, pVec, nVec, ap, pp, np, DEFAULT_LR);
    }
  }
  return { embeddings: workEmb, positions: workPos };
}
