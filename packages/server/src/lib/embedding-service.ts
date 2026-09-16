import { initKeywordVectors, ProductEmbeddingEngine } from '@labby/core';
import type { RankingJudgment, RankingQuery, TrainingResult } from '@labby/core';
import type { LabbyStore } from '../store/index.js';

export class EmbeddingService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: LabbyStore) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const locked = () => this.store.withSimilarityLock(work);
    const next = this.queue.then(locked, locked);
    this.queue = next.catch(() => {});
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
    await this.queue;
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
