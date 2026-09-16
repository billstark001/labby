import { initKeywordVectors, ProductEmbeddingEngine } from '@labby/core';
import type { RankingJudgment, RankingQuery, TrainingResult } from '@labby/core';
import type { LabbyStore } from '../store/index.js';
import { AppError } from './errors.js';

export class EmbeddingService {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly store: LabbyStore) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    // The store owns serialization. A second queue hides how long a request has waited.
    const next = this.store.withSimilarityLock(work).catch((error) => {
      if (
        error?.code === '55P03' ||
        error?.code === '57014' ||
        error?.message === 'Query read timeout'
      ) {
        throw new AppError(
          'SIMILARITY_BUSY',
          'Similarity storage is busy or timed out. Retry shortly. If this persists, check database locks.',
          503,
        );
      }
      throw error;
    });
    this.pending.add(next);
    void next.finally(() => this.pending.delete(next)).catch(() => {});
    return next;
  }

  private async load(
    persistMissing: boolean,
  ): Promise<{ engine: ProductEmbeddingEngine; missingIds: Set<string> }> {
    const keywords = await this.store.listKeywords();
    const persisted = await this.store.getKeywordVectors(keywords.map((k) => k.id));
    const existing = new Set(persisted.map((v) => v.keywordId));
    const missing = initKeywordVectors(
      keywords.filter((k) => !existing.has(k.id)).map((k) => k.id),
      persisted[0]?.geometry,
    );
    if (persistMissing && missing.length) await this.store.putKeywordVectors(missing);
    return {
      engine: new ProductEmbeddingEngine(
        [...persisted, ...missing].sort((a, b) => a.keywordId.localeCompare(b.keywordId)),
        await this.store.getRankingHistory(),
      ),
      missingIds: new Set(missing.map((v) => v.keywordId)),
    };
  }

  async start(): Promise<void> {
    await this.serial(async () => {
      await this.load(true);
    });
  }
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  recommendRanking(options: {
    size?: number;
    excludedKeys?: string[];
  }): Promise<RankingQuery | null> {
    return this.serial(async () => (await this.load(true)).engine.recommendRanking(options));
  }

  trainRanking(judgment: RankingJudgment): Promise<TrainingResult> {
    return this.serial(async () => {
      const { engine, missingIds } = await this.load(false);
      const result = engine.trainRanking(judgment);
      if (result.accepted) {
        const changed = new Set(result.updatedVectors.map((v) => v.keywordId));
        result.updatedVectors.push(
          ...engine
            .getVectors()
            .filter((v) => missingIds.has(v.keywordId) && !changed.has(v.keywordId)),
        );
        await this.store.commitRanking(result.updatedVectors, result.history);
      }
      return result;
    });
  }
}
