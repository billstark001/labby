import type { KeywordVector, SupervisionQuery, TripletQuery } from '@labby/core';
import { initKeywordVectors } from '@labby/core';

import { EmbeddingEngineAdapter } from './embedding-engine.js';
import type { SqliteStore } from '../store/index.js';

const LATENT_DIM = 64;

function stableIdCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class EmbeddingService {
  private engine: EmbeddingEngineAdapter | null = null;
  private orderedKeywordIds: string[] = [];
  private keywordIndex = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stale = true;
  private pendingWrites = new Map<string, KeywordVector>();

  constructor(
    private readonly store: SqliteStore,
    private readonly flushIntervalMs = 5000,
  ) {}

  async start(): Promise<void> {
    await this.ensureInitialized();
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        void this.flushDirtyToStore().catch((err) => {
          console.error('[embedding] periodic flush failed', err);
        });
      }, this.flushIntervalMs);
    }
  }

  invalidate(): void {
    this.stale = true;
  }

  async updateTriplet(
    anchorId: string,
    positiveId: string,
    negativeId: string,
    margin: number,
    learningRate: number,
  ): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
    await this.ensureInitialized();

    const a = this.keywordIndex.get(anchorId);
    const b = this.keywordIndex.get(positiveId);
    const c = this.keywordIndex.get(negativeId);
    if (a === undefined || b === undefined || c === undefined || !this.engine) {
      throw new Error('triplet ids not found in embedding engine');
    }

    const loss = this.engine.updateTriplet(a, b, c, margin, learningRate);
    const updatedVectors = this.collectDirtyVectors();
    for (const vector of updatedVectors) {
      this.pendingWrites.set(vector.keywordId, vector);
    }
    return { loss, updatedVectors };
  }

  async recommendTriplet(excludedPairKeys: string[]): Promise<TripletQuery | null> {
    await this.ensureInitialized();
    if (!this.engine) {
      throw new Error('embedding engine not initialized');
    }

    const pairIndices: number[] = [];
    for (const key of excludedPairKeys) {
      const [leftId, rightId] = key.split('|');
      if (!leftId || !rightId) continue;
      const left = this.keywordIndex.get(leftId);
      const right = this.keywordIndex.get(rightId);
      if (left === undefined || right === undefined) continue;
      pairIndices.push(left, right);
    }

    const recommended = this.engine.recommendTriplet(Uint32Array.from(pairIndices));
    if (!recommended) {
      return null;
    }

    const [anchorIndex, positiveIndex, negativeIndex] = recommended;
    const anchorId = this.orderedKeywordIds[anchorIndex];
    const positiveId = this.orderedKeywordIds[positiveIndex];
    const negativeId = this.orderedKeywordIds[negativeIndex];
    if (!anchorId || !positiveId || !negativeId) {
      return null;
    }

    return {
      anchorId,
      positiveId,
      negativeId,
    };
  }

  async updatePair(
    leftId: string,
    rightId: string,
    targetDistance: number,
    learningRate: number,
  ): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
    await this.ensureInitialized();

    const a = this.keywordIndex.get(leftId);
    const b = this.keywordIndex.get(rightId);
    if (a === undefined || b === undefined || !this.engine) {
      throw new Error('pair ids not found in embedding engine');
    }

    const loss = this.engine.updatePair(a, b, targetDistance, learningRate);
    const updatedVectors = this.collectDirtyVectors();
    for (const vector of updatedVectors) {
      this.pendingWrites.set(vector.keywordId, vector);
    }
    return { loss, updatedVectors };
  }

  async applySupervision(
    query: SupervisionQuery,
  ): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
    await this.ensureInitialized();
    if (!this.engine) {
      throw new Error('embedding engine not initialized');
    }

    if (query.kind === 'pair') {
      return this.updatePair(
        query.leftId,
        query.rightId,
        query.targetDistance,
        query.learningRate ?? 0.05,
      );
    }

    const anchor = this.keywordIndex.get(query.anchorId);
    if (anchor === undefined) {
      throw new Error('ranked supervision anchor not found');
    }

    const ordered = query.orderedIds
      .map((keywordId: string) => ({
        keywordId,
        index: this.keywordIndex.get(keywordId),
      }))
      .filter((item: { keywordId: string; index: number | undefined }): item is { keywordId: string; index: number } => item.index !== undefined);

    if (ordered.length < 2) {
      return { loss: 0, updatedVectors: [] };
    }

    const triplets: number[] = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      const positive = ordered[i]?.index;
      const negative = ordered[i + 1]?.index;
      if (positive === undefined || negative === undefined) continue;
      triplets.push(anchor, positive, negative);
    }

    if (triplets.length === 0) {
      return { loss: 0, updatedVectors: [] };
    }

    const updatedNodes = this.engine.updateTripletsBatchFlush(
      Uint32Array.from(triplets),
      query.margin ?? 0.2,
      query.learningRate ?? 0.05,
    );
    const updatedVectors = this.collectDirtyVectorsFromNodes(updatedNodes);
    for (const vector of updatedVectors) {
      this.pendingWrites.set(vector.keywordId, vector);
    }
    return {
      // Batch API currently does not return per-triplet loss.
      loss: 0,
      updatedVectors,
    };
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    const dirty = this.collectDirtyVectors();
    for (const vector of dirty) {
      this.pendingWrites.set(vector.keywordId, vector);
    }
    await this.flushBufferedWrites();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.stale && this.engine) return;

    const keywords = await this.store.listKeywords();
    const keywordIds = keywords.map((k) => k.id).sort(stableIdCompare);
    const persisted = await this.store.getKeywordVectors(keywordIds);
    const byId = new Map(persisted.map((item) => [item.keywordId, item]));

    const missing = keywordIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const seeded = initKeywordVectors(missing);
      await this.store.putKeywordVectors(seeded);
      for (const vec of seeded) {
        byId.set(vec.keywordId, vec);
      }
    }

    const orderedVectors = keywordIds
      .map((id) => byId.get(id))
      .filter((value): value is KeywordVector => Boolean(value));

    const flat = new Float32Array(orderedVectors.length * LATENT_DIM);
    for (let i = 0; i < orderedVectors.length; i++) {
      const vec = orderedVectors[i].vector64;
      for (let j = 0; j < LATENT_DIM; j++) {
        flat[i * LATENT_DIM + j] = vec[j] ?? 0;
      }
    }

    this.engine = await EmbeddingEngineAdapter.create(Math.max(orderedVectors.length, 16));
    this.engine.hydrate(flat, orderedVectors.length);
    this.orderedKeywordIds = keywordIds;
    this.keywordIndex = new Map(keywordIds.map((id, i) => [id, i]));
    this.stale = false;
  }

  private async flushDirtyToStore(): Promise<KeywordVector[]> {
    const dirty = this.collectDirtyVectors();
    if (dirty.length === 0) return [];
    for (const update of dirty) {
      this.pendingWrites.set(update.keywordId, update);
    }
    await this.flushBufferedWrites();
    return dirty;
  }

  private collectDirtyVectors(): KeywordVector[] {
    if (!this.engine) return [];
    const dirty = this.engine.flushDirtyNodes();
    if (dirty.length === 0) return [];

    const now = Date.now();
    const updates: KeywordVector[] = [];
    for (const node of dirty) {
      const keywordId = this.orderedKeywordIds[node.id];
      if (!keywordId) continue;
      updates.push({
        keywordId,
        vector64: node.coords64d,
        x: node.coords2d[0],
        y: node.coords2d[1],
        updatedAt: now,
      });
    }
    return updates;
  }

  private collectDirtyVectorsFromNodes(
    dirty: Array<{ id: number; coords64d: number[]; coords2d: [number, number] }>,
  ): KeywordVector[] {
    if (dirty.length === 0) return [];
    const now = Date.now();
    const updates: KeywordVector[] = [];
    for (const node of dirty) {
      const keywordId = this.orderedKeywordIds[node.id];
      if (!keywordId) continue;
      updates.push({
        keywordId,
        vector64: node.coords64d,
        x: node.coords2d[0],
        y: node.coords2d[1],
        updatedAt: now,
      });
    }
    return updates;
  }

  private async flushBufferedWrites(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    const values = [...this.pendingWrites.values()];
    this.pendingWrites.clear();
    await this.store.putKeywordVectors(values);
  }
}
