import { describe, expect, test } from 'vitest';
import {
  initKeywordVectors,
  productDistance,
  keywordVectorsToSimilarityLookup,
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
        const lookup = keywordVectorsToSimilarityLookup(vectors);
        const similarities = vectors.flatMap((a, i) => vectors.slice(i + 1).map(b => lookup.getPairSimilarity(a.keywordId, b.keywordId)!));

        let finiteCount = 0;
        for (const value of similarities) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
          finiteCount++;
        }

        return finiteCount > 0;
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
        const similarities = keywordVectorsToSimilarityLookup(baseVectors);

        const fullSessions = solveFull({ persons, similarities, config });
        const fullPlan: SchedulePlan = {
          id: `plan-full-${seed}`,
          createdAt: Date.now(),
          configId: config.id,
          sessions: fullSessions,
        };
        const changeDate = '2026-05-01';
        const incrementalSessions = solveIncremental({
          persons,
          similarities,
          config,
          sessions: fullPlan.sessions,
          changeDate,
        });
        const incrementalPlan: SchedulePlan = {
          ...fullPlan,
          sessions: incrementalSessions,
        };

        const activeIds = new Set(persons.filter(p => !p.disabled).map(p => p.id));
        assertBasicScheduleInvariants(fullPlan.sessions, activeIds);
        assertBasicScheduleInvariants(incrementalPlan.sessions, activeIds);

        const prevFrozen = fullPlan.sessions.filter((s: Session) => s.date < changeDate);
        const incFrozen = incrementalPlan.sessions.filter((s: Session) => s.date < changeDate);
        expect(incFrozen).toEqual(prevFrozen);

        return true;
      });

      if (ok) validRounds++;
    }

    console.log(`schedule fuzz valid ratio=${validRounds}/${rounds}`);
    expect(validRounds).toBe(rounds);
  }, 30_000);

  test('large-point metric fuzz preserves product-space triangle inequality', () => {
    const rounds = 24;
    let pass = 0;

    for (let seed = 300; seed < 300 + rounds; seed++) {
      const ok = withSeed(seed, () => {
        const ids = Array.from({ length: randomInt(90, 140) }, (_, i) => `v-${i}`);
        const vectors = initKeywordVectors(ids);
        const lookup = keywordVectorsToSimilarityLookup(vectors);
        const similarities = vectors.flatMap((a, i) => vectors.slice(i + 1).map(b => lookup.getPairSimilarity(a.keywordId, b.keywordId)!));

        // All distinct pairs must have finite similarity.
        expect(similarities.length).toBe((ids.length * (ids.length - 1)) / 2);
        for (const value of similarities) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
        }

        // Random triples satisfy triangle inequality in the product metric.
        for (let i = 0; i < 320; i++) {
          const a = vectors[randomInt(0, vectors.length - 1)];
          const b = vectors[randomInt(0, vectors.length - 1)];
          const c = vectors[randomInt(0, vectors.length - 1)];
          const dAB = productDistance(a, b);
          const dAC = productDistance(a, c);
          const dBC = productDistance(b, c);
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
