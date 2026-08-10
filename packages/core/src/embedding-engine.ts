import type { IterativeUpdateOptions } from './types.js';
import type { GraphSnapshotEdge } from './db.js';

export const EMBEDDING_DIMENSIONS = 64;

export interface EmbeddingDirtyNode {
  id: number;
  coords64d: number[];
  coords2d: [number, number];
}

export function buildSimilarityGraphEdges(vectors: readonly { keywordId: string; vector64: readonly number[] }[], neighbors = 4): GraphSnapshotEdge[] {
  const edges = new Map<string, GraphSnapshotEdge>();
  for (let sourceIndex = 0; sourceIndex < vectors.length; sourceIndex += 1) {
    const source = vectors[sourceIndex]!;
    const nearest: Array<{ targetId: string; distance: number }> = [];
    for (let targetIndex = 0; targetIndex < vectors.length; targetIndex += 1) {
      if (sourceIndex === targetIndex) continue;
      const target = vectors[targetIndex]!;
      let squared = 0;
      for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
        const delta = (source.vector64[dimension] ?? 0) - (target.vector64[dimension] ?? 0);
        squared += delta * delta;
      }
      nearest.push({ targetId: target.keywordId, distance: Math.sqrt(squared) });
    }
    nearest.sort((left, right) => left.distance - right.distance || left.targetId.localeCompare(right.targetId));
    for (const target of nearest.slice(0, Math.max(0, neighbors))) {
      const [sourceId, targetId] = source.keywordId < target.targetId
        ? [source.keywordId, target.targetId]
        : [target.targetId, source.keywordId];
      const key = `${sourceId}|${targetId}`;
      edges.set(key, { sourceId, targetId, weight: 1 / (1 + target.distance) });
    }
  }
  return [...edges.values()];
}

const DEFAULT_OPTIONS: Required<IterativeUpdateOptions> = {
  learningRate: 0.05,
  minIters: 2,
  maxIters: 16,
  stabilityWindow: 3,
  stabilityTolerance: 1e-3,
};

function resolveOptions(options?: IterativeUpdateOptions): Required<IterativeUpdateOptions> {
  const minIters = Math.max(1, Math.floor(options?.minIters ?? DEFAULT_OPTIONS.minIters));
  return {
    learningRate: Math.max(1e-6, options?.learningRate ?? DEFAULT_OPTIONS.learningRate),
    minIters,
    maxIters: Math.max(minIters, Math.floor(options?.maxIters ?? DEFAULT_OPTIONS.maxIters)),
    stabilityWindow: Math.max(1, Math.floor(options?.stabilityWindow ?? DEFAULT_OPTIONS.stabilityWindow)),
    stabilityTolerance: Math.max(0, options?.stabilityTolerance ?? DEFAULT_OPTIONS.stabilityTolerance),
  };
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Portable embedding engine shared by browsers and Node.js.
 *
 * The application currently caps local datasets at 1,000 nodes, so exact
 * neighbor scans are both simpler and fast enough. Keeping this implementation
 * in TypeScript removes the native/WASM build from normal development without
 * changing the public supervision contract.
 */
export class PortableEmbeddingEngine {
  private coordinates: Float64Array;
  private count = 0;
  private readonly dirty = new Set<number>();

  constructor(capacity = 16) {
    this.coordinates = new Float64Array(Math.max(16, capacity) * EMBEDDING_DIMENSIONS);
  }

  static async create(capacity = 16): Promise<PortableEmbeddingEngine> {
    return new PortableEmbeddingEngine(capacity);
  }

  hydrate(data: Float32Array | Float64Array, nNodes: number): void {
    if (data.length !== nNodes * EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding data length must equal nNodes * ${EMBEDDING_DIMENSIONS}`);
    }
    this.ensureCapacity(nNodes);
    this.coordinates.fill(0);
    this.coordinates.set(data);
    this.count = nNodes;
    this.dirty.clear();
  }

  recommendTriplet(excludedPairs: Uint32Array): [number, number, number] | null {
    if (this.count < 3) return null;
    const excluded = new Set<string>();
    for (let index = 0; index + 1 < excludedPairs.length; index += 2) {
      excluded.add(pairKey(excludedPairs[index]!, excludedPairs[index + 1]!));
    }

    let best: { anchor: number; positive: number; negative: number; gap: number } | null = null;
    for (let anchor = 0; anchor < this.count; anchor += 1) {
      const neighbors: Array<{ id: number; distance: number }> = [];
      for (let id = 0; id < this.count; id += 1) {
        if (id === anchor) continue;
        neighbors.push({ id, distance: Math.sqrt(this.distanceSquared(anchor, id)) });
      }
      neighbors.sort((left, right) => left.distance - right.distance || left.id - right.id);
      const cap = Math.min(neighbors.length - 1, 24);
      for (let index = 0; index < cap; index += 1) {
        const positive = neighbors[index]!;
        const negative = neighbors[index + 1]!;
        if (excluded.has(pairKey(anchor, positive.id))) continue;
        const gap = Math.abs(negative.distance - positive.distance);
        if (!best || gap < best.gap) {
          best = { anchor, positive: positive.id, negative: negative.id, gap };
        }
      }
    }

    return best ? [best.anchor, best.positive, best.negative] : null;
  }

  updateTriplet(
    idA: number,
    idB: number,
    idC: number,
    margin: number,
    options?: IterativeUpdateOptions,
  ): number {
    this.assertNodeIds(idA, idB, idC);
    const resolved = resolveOptions(options);
    const initialLoss = Math.max(0, this.distanceSquared(idA, idB) - this.distanceSquared(idA, idC) + margin);
    if (initialLoss <= 0) return 0;

    const recent: number[] = [];
    for (let iteration = 0; iteration < resolved.maxIters; iteration += 1) {
      const loss = Math.max(0, this.distanceSquared(idA, idB) - this.distanceSquared(idA, idC) + margin);
      if (loss <= 0 && iteration + 1 >= resolved.minIters) break;
      this.applyTripletGradient(idA, idB, idC, resolved.learningRate);
      this.markDirty(idA, idB, idC);
      recent.push(loss);
      if (recent.length > resolved.stabilityWindow) recent.shift();
      if (
        iteration + 1 >= resolved.minIters
        && recent.length === resolved.stabilityWindow
        && Math.max(...recent) - Math.min(...recent) <= resolved.stabilityTolerance
      ) break;
    }
    return initialLoss;
  }

  updatePair(
    idA: number,
    idB: number,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): number {
    this.assertNodeIds(idA, idB);
    const resolved = resolveOptions(options);
    const initialDistance = Math.sqrt(this.distanceSquared(idA, idB));
    const initialLoss = (initialDistance - targetDistance) ** 2;
    const recent: number[] = [];

    for (let iteration = 0; iteration < resolved.maxIters; iteration += 1) {
      const distance = Math.sqrt(this.distanceSquared(idA, idB));
      const error = distance - targetDistance;
      const loss = error * error;
      if (loss <= resolved.stabilityTolerance && iteration + 1 >= resolved.minIters) break;
      const denominator = Math.max(distance, 1e-9);
      for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
        const leftIndex = this.offset(idA, dimension);
        const rightIndex = this.offset(idB, dimension);
        const delta = this.coordinates[leftIndex]! - this.coordinates[rightIndex]!;
        const gradient = 2 * error * delta / denominator;
        const step = resolved.learningRate * gradient * 0.5;
        this.coordinates[leftIndex] -= step;
        this.coordinates[rightIndex] += step;
      }
      this.markDirty(idA, idB);
      recent.push(loss);
      if (recent.length > resolved.stabilityWindow) recent.shift();
      if (
        iteration + 1 >= resolved.minIters
        && recent.length === resolved.stabilityWindow
        && Math.max(...recent) - Math.min(...recent) <= resolved.stabilityTolerance
      ) break;
    }
    return initialLoss;
  }

  updateTripletsBatchFlush(
    triplets: Uint32Array,
    margin: number,
    options?: IterativeUpdateOptions,
  ): EmbeddingDirtyNode[] {
    for (let index = 0; index + 2 < triplets.length; index += 3) {
      this.updateTriplet(triplets[index]!, triplets[index + 1]!, triplets[index + 2]!, margin, options);
    }
    return this.flushDirtyNodes();
  }

  updatePairsBatchFlush(
    pairs: Uint32Array,
    targetDistance: number,
    options?: IterativeUpdateOptions,
  ): EmbeddingDirtyNode[] {
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      this.updatePair(pairs[index]!, pairs[index + 1]!, targetDistance, options);
    }
    return this.flushDirtyNodes();
  }

  flushDirtyNodes(): EmbeddingDirtyNode[] {
    const nodes = [...this.dirty]
      .sort((left, right) => left - right)
      .map((id) => ({
        id,
        coords64d: this.vectorFor(id),
        coords2d: this.projectionFor(id),
      } satisfies EmbeddingDirtyNode));
    this.dirty.clear();
    return nodes;
  }

  private ensureCapacity(required: number): void {
    if (required * EMBEDDING_DIMENSIONS <= this.coordinates.length) return;
    let capacity = Math.max(16, this.coordinates.length / EMBEDDING_DIMENSIONS);
    while (capacity < required) capacity *= 2;
    const next = new Float64Array(capacity * EMBEDDING_DIMENSIONS);
    next.set(this.coordinates);
    this.coordinates = next;
  }

  private offset(id: number, dimension: number): number {
    return id * EMBEDDING_DIMENSIONS + dimension;
  }

  private distanceSquared(left: number, right: number): number {
    let sum = 0;
    for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
      const delta = this.coordinates[this.offset(left, dimension)]! - this.coordinates[this.offset(right, dimension)]!;
      sum += delta * delta;
    }
    return sum;
  }

  private applyTripletGradient(anchor: number, positive: number, negative: number, learningRate: number): void {
    for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
      const anchorIndex = this.offset(anchor, dimension);
      const positiveIndex = this.offset(positive, dimension);
      const negativeIndex = this.offset(negative, dimension);
      const a = this.coordinates[anchorIndex]!;
      const b = this.coordinates[positiveIndex]!;
      const c = this.coordinates[negativeIndex]!;
      const gradientA = 2 * (c - b);
      const gradientB = 2 * (b - a);
      const gradientC = 2 * (a - c);
      this.coordinates[anchorIndex] = a - learningRate * gradientA;
      this.coordinates[positiveIndex] = b - learningRate * gradientB;
      this.coordinates[negativeIndex] = c - learningRate * gradientC;
    }
  }

  private vectorFor(id: number): number[] {
    const start = id * EMBEDDING_DIMENSIONS;
    return Array.from(this.coordinates.subarray(start, start + EMBEDDING_DIMENSIONS));
  }

  private projectionFor(id: number): [number, number] {
    return [this.coordinates[this.offset(id, 0)] ?? 0, this.coordinates[this.offset(id, 1)] ?? 0];
  }

  private markDirty(...ids: number[]): void {
    for (const id of ids) this.dirty.add(id);
  }

  private assertNodeIds(...ids: number[]): void {
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= this.count) {
        throw new Error(`embedding node id out of bounds: ${id}`);
      }
    }
  }
}
