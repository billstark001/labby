import { describe, expect, test } from 'vitest';
import {
  initKeywordVectors,
  keywordVectorsToSimilarityMap,
  nextTripletQueryFromKeywordVectors,
  solveFull,
  solveIncremental,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
  type Session,
} from '../src/index';

function withSeed<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeRandomPersons(n: number, keywordPool: string[]): Person[] {
  const people: Person[] = [];
  for (let i = 0; i < n; i++) {
    const keywordCount = randomInt(1, Math.min(3, keywordPool.length));
    const ids = [...keywordPool]
      .sort(() => Math.random() - 0.5)
      .slice(0, keywordCount);

    people.push({
      id: `p-${i}`,
      name: `P-${i}`,
      names: { en: `P-${i}` },
      metadata: {},
      keywordIds: ids,
      disabled: Math.random() < 0.1,
    });
  }
  return people;
}

function makeRandomConfig(id = 'cfg-fuzz'): ScheduleConfig {
  const presenters = randomInt(1, 3);
  const questioners = randomInt(1, 3);
  const days = [1, 2, 3, 4, 5].filter(() => Math.random() < 0.5);

  return {
    id,
    daysOfWeek: days.length > 0 ? days : [1],
    timeRange: ['14:00', '16:00'],
    presentersPerSession: presenters,
    questionersPerPresenter: questioners,
    targetSimilarityRadius: Math.random(),
    startDate: '2026-04-01',
    endDate: '2026-05-31',
  };
}

function assertBasicScheduleInvariants(
  sessions: Session[],
  activeIds: Set<string>,
): void {
  for (const session of sessions) {
    const presenterSet = new Set<string>();

    for (const presentation of session.presentations) {
      expect(activeIds.has(presentation.presenterId)).toBe(true);
      expect(presenterSet.has(presentation.presenterId)).toBe(false);
      presenterSet.add(presentation.presenterId);

      const questionerSet = new Set<string>();
      for (const q of presentation.questionerIds) {
        expect(activeIds.has(q)).toBe(true);
        expect(q).not.toBe(presentation.presenterId);
        expect(questionerSet.has(q)).toBe(false);
        questionerSet.add(q);
      }
    }
  }
}

describe('Fuzzy benchmark: keyword-distance + scheduling black-box robustness', () => {
  test('keyword-vector random query benchmark', () => {
    const rounds = 80;
    let valid = 0;

    for (let seed = 1; seed <= rounds; seed++) {
      const result = withSeed(seed, () => {
        const keywordCount = randomInt(30, 50);
        const keywords = Array.from({ length: keywordCount }, (_, i) => `k${i}`);
        const vectors = initKeywordVectors(keywords);
        const simMap = keywordVectorsToSimilarityMap(vectors);
        const query = nextTripletQueryFromKeywordVectors(vectors);

        let finiteCount = 0;
        for (const value of simMap.values()) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
          finiteCount++;
        }

        return finiteCount > 0 && query !== null;
      });

      if (result) valid++;
    }

    console.log(`keyword-vector fuzz valid ratio=${valid}/${rounds}`);
    expect(valid).toBe(rounds);
  });

  test('scheduling random scenario benchmark (full + incremental)', () => {
    const rounds = 60;
    let validRounds = 0;

    for (let seed = 100; seed < 100 + rounds; seed++) {
      const ok = withSeed(seed, () => {
        const keywordPool = Array.from({ length: randomInt(30, 50) }, (_, i) => `k${i}`);
        const persons = makeRandomPersons(randomInt(5, 12), keywordPool);
        const config = makeRandomConfig(`cfg-${seed}`);

        const baseVectors = initKeywordVectors(keywordPool);
        const similarities = keywordVectorsToSimilarityMap(baseVectors);

        const full = solveFull({ persons, similarities, config });
        const changeDate = '2026-05-01';
        const incremental: SchedulePlan = solveIncremental({
          persons,
          similarities,
          config,
          previousPlan: full,
          changeDate,
        });

        const activeIds = new Set(persons.filter(p => !p.disabled).map(p => p.id));
        assertBasicScheduleInvariants(full.sessions, activeIds);
        assertBasicScheduleInvariants(incremental.sessions, activeIds);

        const prevFrozen = full.sessions.filter(s => s.date < changeDate);
        const incFrozen = incremental.sessions.filter(s => s.date < changeDate);
        expect(incFrozen).toEqual(prevFrozen);

        return true;
      });

      if (ok) validRounds++;
    }

    console.log(`schedule fuzz valid ratio=${validRounds}/${rounds}`);
    expect(validRounds).toBe(rounds);
  });

  test('large-point metric fuzz preserves L2 triangle inequality', () => {
    const rounds = 24;
    let pass = 0;

    const l2 = (va: number[], vb: number[]) => {
      let sum = 0;
      for (let i = 0; i < 64; i++) {
        const d = (va[i] ?? 0) - (vb[i] ?? 0);
        sum += d * d;
      }
      return Math.sqrt(sum);
    };

    for (let seed = 300; seed < 300 + rounds; seed++) {
      const ok = withSeed(seed, () => {
        const ids = Array.from({ length: randomInt(90, 140) }, (_, i) => `v-${i}`);
        const vectors = initKeywordVectors(ids);
        const simMap = keywordVectorsToSimilarityMap(vectors);

        // Pairwise similarity map must be dense and finite.
        expect(simMap.size).toBe((ids.length * (ids.length - 1)) / 2);
        for (const value of simMap.values()) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
        }

        // Random triplets satisfy triangle inequality in 64D Euclidean space.
        for (let i = 0; i < 320; i++) {
          const a = vectors[randomInt(0, vectors.length - 1)];
          const b = vectors[randomInt(0, vectors.length - 1)];
          const c = vectors[randomInt(0, vectors.length - 1)];
          const dAB = l2(a.vector64, b.vector64);
          const dAC = l2(a.vector64, c.vector64);
          const dBC = l2(b.vector64, c.vector64);
          expect(dAC).toBeLessThanOrEqual(dAB + dBC + 1e-6);
        }
        return true;
      });

      if (ok) pass++;
    }

    console.log(`metric fuzz valid ratio=${pass}/${rounds}`);
    expect(pass).toBe(rounds);
  });
});
