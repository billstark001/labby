import { describe, expect, it } from 'vitest';
import { ProductEmbeddingEngine, rankingQueryKey } from '../src/index.js';
import { squaredProductDistance } from '../src/embedding/geometry.js';
import type { KeywordVector, RankingJudgment } from '../src/types.js';

const geometry = { hyperbolicDimensions: 4, euclideanDimensions: 4 };
function vectors(count = 12, seed = 1): KeywordVector[] {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  return Array.from({ length: count }, (_, i) => ({ keywordId: String(i), geometry: { ...geometry }, embedding: Array.from({ length: 8 }, () => (random() - 0.5) / 2), x: 0, y: 0, updatedAt: 1 }));
}
const judgment = (id: string, anchorId: string, groups: string[][]): RankingJudgment => ({ id, anchorId, groups, confidence: 1, createdAt: 1 });
function assertRanking(engine: ProductEmbeddingEngine, j: RankingJudgment) {
  const byId = new Map(engine.getVectors().map(v => [v.keywordId, v]));
  const distance = (id: string) => squaredProductDistance(byId.get(j.anchorId)!.embedding, byId.get(id)!.embedding, geometry);
  for (let g = 0; g < j.groups.length; g++) {
    for (const b of j.groups[g]!) for (const c of j.groups[g]!) expect(Math.abs(distance(b) - distance(c))).toBeLessThanOrEqual(0.04000001);
    for (let h = g + 1; h < j.groups.length; h++) for (const b of j.groups[g]!) for (const c of j.groups[h]!) expect(distance(b)).toBeLessThan(distance(c));
  }
}

describe('joint ranking engine', () => {
  it('learns a strict list from a completely collapsed cluster', () => {
    const initial = vectors(6).map(v => ({ ...v, embedding: Array(8).fill(0) }));
    const engine = new ProductEmbeddingEngine(initial);
    const j = judgment('collapsed', '0', [['1'], ['2'], ['3'], ['4']]);
    const result = engine.trainRanking(j);
    expect(result.accepted, result.conflicts.join('; ')).toBe(true);
    assertRanking(engine, j);
    expect(result.updatedVectors.length).toBeGreaterThan(0);
    expect(engine.getVectors()[5]).toEqual(initial[5]);
  });

  it.each([1, 7, 29, 103, 997])('fits an entire list with ties from seed %i', seed => {
    const engine = new ProductEmbeddingEngine(vectors(12, seed));
    const j = judgment('list', '0', [['1', '2'], ['3'], ['4', '5']]);
    const result = engine.trainRanking(j);
    expect(result.accepted, result.conflicts.join('; ')).toBe(true);
    assertRanking(engine, j);
    expect(result.history).toEqual([j]);
    expect(engine.getVectors().slice(6)).toEqual(vectors(12, seed).slice(6));
  });

  it('preserves every confirmed comparison when fitting overlapping lists', () => {
    const engine = new ProductEmbeddingEngine(vectors());
    const history = [judgment('first', '0', [['1'], ['2'], ['3']]), judgment('second', '0', [['2'], ['4'], ['5']]), judgment('third', '1', [['0'], ['4'], ['5']])];
    for (let i = 0; i < history.length; i++) {
      const result = engine.trainRanking(history[i]!);
      expect(result.accepted, result.conflicts.join('; ')).toBe(true);
      for (const j of history.slice(0, i + 1)) assertRanking(engine, j);
    }
  });

  it('rejects contradictory judgments atomically and treats repeated ids as idempotent', () => {
    const engine = new ProductEmbeddingEngine(vectors());
    const j = judgment('first', '0', [['1'], ['2']]);
    expect(engine.trainRanking(j).accepted).toBe(true);
    const before = engine.getVectors(), history = engine.getHistory();
    expect(engine.trainRanking(j).updatedVectors).toEqual([]);
    expect(() => engine.trainRanking({ ...j, groups: [['2'], ['1']] })).toThrow(/id/);
    expect(engine.trainRanking(judgment('conflict', '0', [['2'], ['1']])).accepted).toBe(false);
    expect(engine.trainRanking(judgment('tie', '0', [['1', '2']])).accepted).toBe(false);
    expect(engine.getVectors()).toEqual(before);
    expect(engine.getHistory()).toEqual(history);
  });

  it('detects cycles between symmetric distances across different anchors', () => {
    const engine = new ProductEmbeddingEngine(vectors());
    expect(engine.trainRanking(judgment('ab<ac', '0', [['1'], ['2']])).accepted).toBe(true);
    expect(engine.trainRanking(judgment('ac<bc', '2', [['0'], ['1']])).accepted).toBe(true);
    const before = engine.getVectors();
    const result = engine.trainRanking(judgment('bc<ab', '1', [['2'], ['0']]));
    expect(result.accepted).toBe(false);
    expect(result.conflicts.join()).toMatch(/cycle/);
    expect(engine.getVectors()).toEqual(before);
  });

  it('leaves state untouched when an insufficient optimization budget cannot fit a list', () => {
    const initial = vectors();
    const engine = new ProductEmbeddingEngine(initial);
    const anchor = initial[0]!;
    const farToNear = initial.slice(1, 6).sort((a, b) => squaredProductDistance(anchor.embedding, b.embedding, geometry) - squaredProductDistance(anchor.embedding, a.embedding, geometry));
    const result = engine.trainRanking(judgment('too-short', '0', farToNear.map(v => [v.keywordId])), { maxIterations: 1, learningRate: 1e-12 });
    expect(result.accepted).toBe(false);
    expect(result.updatedVectors).toEqual([]);
    expect(engine.getVectors()).toEqual(initial);
    expect(engine.getHistory()).toEqual([]);
  });

  it('rejects malformed lists and invalid optimization parameters without mutation', () => {
    const initial = vectors();
    const engine = new ProductEmbeddingEngine(initial);
    for (const groups of [[['1']], [['1'], ['1']], [['0'], ['1']], [['1'], ['missing']], [[]]]) {
      expect(() => engine.trainRanking(judgment('bad', '0', groups))).toThrow();
    }
    for (const options of [{ maxIterations: 0 }, { maxIterations: 1.5 }, { learningRate: NaN }, { historyWeight: -1 }, { driftWeight: Infinity }]) {
      expect(() => engine.trainRanking(judgment('options', '0', [['1'], ['2']]), options)).toThrow();
    }
    expect(engine.getVectors()).toEqual(initial);
    expect(engine.getHistory()).toEqual([]);
  });

  it('protects its state against mutation through inputs and returned snapshots', () => {
    const initial = vectors();
    const engine = new ProductEmbeddingEngine(initial);
    const before = engine.getVectors();
    initial[0]!.embedding[0] = 999;
    engine.getVectors()[0]!.embedding[0] = 999;
    expect(engine.getVectors()).toEqual(before);
    const j = judgment('first', '0', [['1'], ['2']]);
    const result = engine.trainRanking(j);
    j.groups[0]![0] = '9';
    result.history[0]!.groups[0]![0] = '8';
    expect(engine.getHistory()[0]!.groups).toEqual([['1'], ['2']]);
  });

  it.each([2, 11, 53])('protects previously accepted ties during overlapping training, seed %i', seed => {
    const engine = new ProductEmbeddingEngine(vectors(12, seed));
    const tied = judgment('tie', '0', [['1', '2'], ['3']]);
    expect(engine.trainRanking(tied).accepted).toBe(true);
    const next = judgment('overlap', '1', [['0'], ['4'], ['5']]);
    const result = engine.trainRanking(next);
    expect(result.accepted, result.conflicts.join('; ')).toBe(true);
    assertRanking(engine, tied);
    assertRanking(engine, next);
  });

  it('reconstructs persisted history and drops only judgments involving deleted keywords', () => {
    const engine = new ProductEmbeddingEngine(vectors());
    const retained = judgment('retained', '0', [['1'], ['2']]);
    expect(engine.trainRanking(retained).accepted).toBe(true);
    const removed = judgment('removed', '0', [['1'], ['11']]);
    expect(engine.trainRanking(removed).accepted).toBe(true);
    const restored = new ProductEmbeddingEngine(engine.getVectors().filter(v => v.keywordId !== '11'), engine.getHistory());
    expect(restored.getHistory()).toEqual([retained]);
    expect(restored.trainRanking(judgment('reverse', '0', [['2'], ['1']])).accepted).toBe(false);
    assertRanking(restored, retained);
  });

  it('produces distinct candidates, respects exclusions, and omits fully known comparisons', () => {
    const history = ['0', '1', '2'].map(anchor => judgment(anchor, anchor, [['0', '1', '2'].filter(id => id !== anchor)]));
    expect(new ProductEmbeddingEngine(vectors(3), history).recommendRanking()).toBeNull();
    const engine = new ProductEmbeddingEngine(vectors(15));
    const excludedKeys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const query = engine.recommendRanking({ size: 5, excludedKeys });
      expect(query).not.toBeNull();
      expect(query!.candidateIds).toHaveLength(5);
      expect(new Set(query!.candidateIds).size).toBe(5);
      expect(query!.candidateIds).not.toContain(query!.anchorId);
      expect(query!.key).toBe(rankingQueryKey(query!.anchorId, query!.candidateIds));
      expect(excludedKeys).not.toContain(query!.key);
      excludedKeys.push(query!.key);
    }
  });

  it('supports the 1000-keyword limit and rejects overflow', () => {
    const engine = new ProductEmbeddingEngine(vectors(1000));
    const start = performance.now();
    const query = engine.recommendRanking();
    expect(query!.candidateIds).toHaveLength(5);
    expect(performance.now() - start).toBeLessThan(5000);
    const trainingStart = performance.now();
    const ranking = judgment('limit', query!.anchorId, query!.candidateIds.map(id => [id]));
    const result = engine.trainRanking(ranking);
    expect(result.accepted, result.conflicts.join('; ')).toBe(true);
    assertRanking(engine, ranking);
    expect(performance.now() - trainingStart).toBeLessThan(5000);
    expect(() => new ProductEmbeddingEngine(vectors(1001))).toThrow(/1000/);
  });
});
