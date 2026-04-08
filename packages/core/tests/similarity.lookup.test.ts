import { describe, expect, test } from 'vitest';
import type { SimilarityLookup, SolverInput } from '../src/types.js';
import { buildCostContext } from '../src/schedule/constraints.js';
import { getPersonSimilarity } from '../src/nlp.js';

function makeInput(similarities: Map<string, number>): SolverInput {
  const similarityLookup: SimilarityLookup = {
    getPairSimilarity: (a: string, b: string): number => {
      return similarities.get(`${a}|${b}`) ?? similarities.get(`${b}|${a}`) ?? 0;
    },
  };
  return {
    config: {
      id: 'cfg-sim',
      daysOfWeek: [1],
      timeRange: ['14:00', '16:00'],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    },
    persons: [
      { id: 'p1', name: 'P1', names: { en: 'P1' }, metadata: {}, keywordIds: ['kA', 'kX'] },
      { id: 'p2', name: 'P2', names: { en: 'P2' }, metadata: {}, keywordIds: ['kB'] },
    ],
    similarities: similarityLookup,
  };
}

describe('similarity lookup map behavior', () => {
  test('map lookup accepts reverse key order and preserves weight', () => {
    const ctx = buildCostContext(makeInput(new Map([
      ['kB|kA', 0.82],
    ])));

    expect(ctx.similarities.getPairSimilarity('kA', 'kB')).toBe(0.82);
    expect(ctx.similarities.getPairSimilarity('kB', 'kA')).toBe(0.82);
  });

  test('missing keyword pairs are skipped instead of forcing zero average', () => {
    const ctx = buildCostContext(makeInput(new Map([
      ['kA|kB', 0.9],
    ])));

    const similarity = getPersonSimilarity(['kA', 'kX'], ['kB'], ctx.similarities);
    expect(similarity).toBe(0.675); // (0.9 + 0.45) / 2
  });
});
