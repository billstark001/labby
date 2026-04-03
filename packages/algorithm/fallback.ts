/**
 * Pure TypeScript fallback implementation of EmbeddingEngine.
 *
 * Mirrors the Rust API exactly so the host code works identically
 * regardless of whether the Rust-compiled WASM / native addon is loaded.
 *
 * Complexity summary (N = number of nodes, d = DIMS = 64):
 *   update_triplet  O(d)        vs old O(N²) pairwise similarity rebuild
 *   k_nearest       O(N · d)    vs old O(N²)
 *   similarity      O(d) = O(1)
 *   attract/repel   O(K² · d)   where K = |selected|
 */

export const DIMS = 64;
const MARGIN = 0.2;
const DEFAULT_LR = 0.05;

export interface DirtyResult {
  /** Indices of modified nodes. */
  indices: number[];
  /** Concatenated 64-D embedding vectors for dirty nodes (length = indices.length × DIMS). */
  embeddings64: Float32Array;
  /** Concatenated 2-D positions for dirty nodes (length = indices.length × 2). */
  positions2d: Float32Array;
}

// ---------------------------------------------------------------------------
// Tiny LCG RNG (avoids crypto APIs for deterministic tests)
// ---------------------------------------------------------------------------
function makeLcg(seed: number) {
  let state = (seed >>> 0) || 0xdeadbeef;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// EmbeddingEngine class
// ---------------------------------------------------------------------------

export class EmbeddingEngine {
  private readonly _n: number;
  /** Row-major N × DIMS Float32Array. */
  private readonly _emb: Float32Array;
  /** Row-major N × 2 Float32Array. */
  private readonly _pos: Float32Array;
  private readonly _dirty: boolean[];

  constructor(n: number) {
    this._n = n;
    this._emb = new Float32Array(n * DIMS);
    this._pos = new Float32Array(n * 2);
    this._dirty = new Array(n).fill(false);

    const rng = makeLcg(0xdeadbeef);
    for (let i = 0; i < n; i++) {
      // Random unit vector in 64-D
      let normSq = 0;
      for (let k = 0; k < DIMS; k++) {
        const v = rng() * 2 - 1;
        this._emb[i * DIMS + k] = v;
        normSq += v * v;
      }
      const norm = Math.sqrt(normSq) || 1e-8;
      for (let k = 0; k < DIMS; k++) this._emb[i * DIMS + k] /= norm;
      // Random 2-D position
      this._pos[i * 2] = rng() * 2 - 1;
      this._pos[i * 2 + 1] = rng() * 2 - 1;
    }
  }

  get size(): number { return this._n; }

  setEmbedding(idx: number, data: ArrayLike<number>): void {
    const base = idx * DIMS;
    for (let k = 0; k < DIMS; k++) this._emb[base + k] = data[k];
    this._dirty[idx] = true;
  }

  setPosition2d(idx: number, x: number, y: number): void {
    this._pos[idx * 2] = x;
    this._pos[idx * 2 + 1] = y;
    this._dirty[idx] = true;
  }

  getEmbedding(idx: number): Float32Array {
    return this._emb.slice(idx * DIMS, (idx + 1) * DIMS);
  }

  getPosition2d(idx: number): [number, number] {
    return [this._pos[idx * 2], this._pos[idx * 2 + 1]];
  }

  /** Flat Float32Array of length 2 * n: [x0, y0, x1, y1, ...] */
  getAllPositions2d(): Float32Array {
    return this._pos.slice();
  }

  /** Similarity ∈ (0, 1] between nodes i and j. */
  similarity(i: number, j: number): number {
    const d = this._dist64(i, j);
    return 1 / (1 + d);
  }

  /** Apply one triplet-loss gradient step (modifies internal state). */
  updateTriplet(anchor: number, pos: number, neg: number, lr = DEFAULT_LR): void {
    this._tripletStep64(anchor, pos, neg, lr);
    this._tripletStep2d(anchor, pos, neg, lr);
    this._dirty[anchor] = true;
    this._dirty[pos] = true;
    this._dirty[neg] = true;
  }

  /** Move all nodes in `indices` toward each other. */
  attract(indices: number[], strength = 0.1): void {
    this._adjustGroup(indices, strength);
  }

  /** Move all nodes in `indices` away from each other. */
  repel(indices: number[], strength = 0.1): void {
    this._adjustGroup(indices, -strength);
  }

  /**
   * Return the indices of the k nearest neighbours of node `idx`
   * in 64-D space (ascending distance order, excluding `idx` itself). O(N·d).
   */
  kNearest(idx: number, k: number): number[] {
    const dists: { d: number; i: number }[] = [];
    for (let i = 0; i < this._n; i++) {
      if (i === idx) continue;
      dists.push({ d: this._sqDist64(idx, i), i });
    }
    dists.sort((a, b) => a.d - b.d);
    return dists.slice(0, k).map(x => x.i);
  }

  /**
   * Return dirty node data and clear dirty flags.
   */
  flushDirty(): DirtyResult {
    const indices: number[] = [];
    for (let i = 0; i < this._n; i++) {
      if (this._dirty[i]) indices.push(i);
    }
    const emb64 = new Float32Array(indices.length * DIMS);
    const pos2d = new Float32Array(indices.length * 2);
    for (let ii = 0; ii < indices.length; ii++) {
      const i = indices[ii];
      emb64.set(this._emb.subarray(i * DIMS, (i + 1) * DIMS), ii * DIMS);
      pos2d[ii * 2] = this._pos[i * 2];
      pos2d[ii * 2 + 1] = this._pos[i * 2 + 1];
      this._dirty[i] = false;
    }
    return { indices, embeddings64: emb64, positions2d: pos2d };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _sqDist64(i: number, j: number): number {
    const bi = i * DIMS;
    const bj = j * DIMS;
    let s = 0;
    for (let k = 0; k < DIMS; k++) {
      const d = this._emb[bi + k] - this._emb[bj + k];
      s += d * d;
    }
    return s;
  }

  private _dist64(i: number, j: number): number {
    return Math.sqrt(this._sqDist64(i, j));
  }

  private _dist2d(i: number, j: number): number {
    const dx = this._pos[i * 2] - this._pos[j * 2];
    const dy = this._pos[i * 2 + 1] - this._pos[j * 2 + 1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  private _tripletStep64(anchor: number, pos: number, neg: number, lr: number): void {
    const dPos = this._dist64(anchor, pos);
    const dNeg = this._dist64(anchor, neg);
    const loss = Math.max(0, dPos - dNeg + MARGIN);
    if (loss === 0) return;

    if (dPos > 1e-8) {
      const ba = anchor * DIMS, bp = pos * DIMS;
      for (let k = 0; k < DIMS; k++) {
        const grad = lr * (this._emb[ba + k] - this._emb[bp + k]) / dPos;
        this._emb[ba + k] -= grad;
        this._emb[bp + k] += grad;
      }
    }
    const dNeg2 = this._dist64(anchor, neg);
    if (dNeg2 > 1e-8) {
      const ba = anchor * DIMS, bn = neg * DIMS;
      for (let k = 0; k < DIMS; k++) {
        const grad = lr * (this._emb[ba + k] - this._emb[bn + k]) / dNeg2;
        this._emb[ba + k] += grad;
        this._emb[bn + k] -= grad;
      }
    }
  }

  private _tripletStep2d(anchor: number, pos: number, neg: number, lr: number): void {
    const dPos = this._dist2d(anchor, pos);
    const dNeg = this._dist2d(anchor, neg);
    const loss = Math.max(0, dPos - dNeg + MARGIN);
    if (loss === 0) return;

    if (dPos > 1e-8) {
      const gx = lr * (this._pos[anchor * 2] - this._pos[pos * 2]) / dPos;
      const gy = lr * (this._pos[anchor * 2 + 1] - this._pos[pos * 2 + 1]) / dPos;
      this._pos[anchor * 2] -= gx; this._pos[anchor * 2 + 1] -= gy;
      this._pos[pos * 2] += gx; this._pos[pos * 2 + 1] += gy;
    }
    const dNeg2 = this._dist2d(anchor, neg);
    if (dNeg2 > 1e-8) {
      const gx = lr * (this._pos[anchor * 2] - this._pos[neg * 2]) / dNeg2;
      const gy = lr * (this._pos[anchor * 2 + 1] - this._pos[neg * 2 + 1]) / dNeg2;
      this._pos[anchor * 2] += gx; this._pos[anchor * 2 + 1] += gy;
      this._pos[neg * 2] -= gx; this._pos[neg * 2 + 1] -= gy;
    }
  }

  private _adjustGroup(indices: number[], signedStrength: number): void {
    for (let ii = 0; ii < indices.length; ii++) {
      for (let jj = ii + 1; jj < indices.length; jj++) {
        const i = indices[ii];
        const j = indices[jj];
        const bi = i * DIMS, bj = j * DIMS;
        for (let k = 0; k < DIMS; k++) {
          const dx = this._emb[bj + k] - this._emb[bi + k];
          this._emb[bi + k] += dx * signedStrength;
          this._emb[bj + k] -= dx * signedStrength;
        }
        const dx2 = this._pos[j * 2] - this._pos[i * 2];
        const dy2 = this._pos[j * 2 + 1] - this._pos[i * 2 + 1];
        this._pos[i * 2] += dx2 * signedStrength;
        this._pos[i * 2 + 1] += dy2 * signedStrength;
        this._pos[j * 2] -= dx2 * signedStrength;
        this._pos[j * 2 + 1] -= dy2 * signedStrength;
        this._dirty[i] = true;
        this._dirty[j] = true;
      }
    }
  }
}

/** Create a new `EmbeddingEngine` for `n` nodes (synchronous, uses TypeScript fallback). */
export function createEngine(n: number): EmbeddingEngine {
  return new EmbeddingEngine(n);
}
