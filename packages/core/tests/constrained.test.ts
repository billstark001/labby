import { describe, expect, test } from 'vitest';
import { initKeywordVectors, keywordVectorsToSimilarityLookup } from '../src/nlp.js';
import { solveConstrained } from '../src/schedule/constrained.js';
import type { Person, ScheduleConfig } from '../src/types.js';

const persons: Person[] = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({
  id,
  name: id,
  names: { en: id },
  metadata: {},
  keywordIds: [`k${index + 1}`],
}));
const config: ScheduleConfig = {
  id: 'config',
  daysOfWeek: [1],
  timeRange: ['14:00', '16:00'],
  presentersPerSession: 2,
  questionersPerPresenter: 2,
  targetSimilarityRadius: 0.5,
  startDate: '2026-04-01',
  endDate: '2026-04-30',
};
const similarities = keywordVectorsToSimilarityLookup(initKeywordVectors(['k1', 'k2', 'k3', 'k4']));

describe('solveConstrained', () => {
  test('preserves fixed slots and fills each null slot exactly once', () => {
    const result = solveConstrained({
      persons,
      config,
      similarities,
      template: [{
        date: '2026-04-06',
        presentations: [
          { presenterId: 'p1', questionerIds: ['p2', null] },
          { presenterId: null, questionerIds: [null] },
        ],
      }],
    });

    expect(result[0]!.presentations).toHaveLength(2);
    expect(result[0]!.presentations[0]!.presenterId).toBe('p1');
    expect(result[0]!.presentations[0]!.questionerIds[0]).toBe('p2');
    expect(result[0]!.presentations[0]!.questionerIds).toHaveLength(2);
    expect(result[0]!.presentations[1]!.questionerIds).toHaveLength(1);
  });

  test('rejects an invalid fixed assignment instead of silently rewriting it', () => {
    expect(() => solveConstrained({
      persons,
      config,
      similarities,
      template: [{ date: '2026-04-06', presentations: [{ presenterId: 'p1', questionerIds: ['p1'] }] }],
    })).toThrow('Fixed questioner p1 is invalid');
  });
});
