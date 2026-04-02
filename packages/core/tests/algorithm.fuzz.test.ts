import { describe, expect, test } from 'vitest';
import {
  embeddingsToSimilarities,
  initEmbeddings,
  runTripletBatch,
  solveFull,
  solveIncremental,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
  type Session,
  type TripletQuery,
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

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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
  test('keyword-distance random triplet benchmark', () => {
    const rounds = 80;
    let improved = 0;

    for (let seed = 1; seed <= rounds; seed++) {
      const result = withSeed(seed, () => {
        const keywordCount = randomInt(6, 12);
        const keywords = Array.from({ length: keywordCount }, (_, i) => `k${i}`);
        const embeddings = initEmbeddings(keywords);

        const queries: TripletQuery[] = Array.from({ length: randomInt(5, 20) }, () => {
          const anchorId = pick(keywords);
          const positiveId = pick(keywords.filter(k => k !== anchorId));
          const negativeId = pick(keywords.filter(k => k !== anchorId && k !== positiveId));
          return { anchorId, positiveId, negativeId };
        });

        const before = embeddingsToSimilarities(embeddings);
        const afterEmbeddings = runTripletBatch(embeddings, queries, 40);
        const after = embeddingsToSimilarities(afterEmbeddings);

        let finiteCount = 0;
        for (const value of after.values()) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
          finiteCount++;
        }

        const q = queries[0];
        const beforePos = before.get([q.anchorId, q.positiveId].sort().join('|')) ?? 0;
        const beforeNeg = before.get([q.anchorId, q.negativeId].sort().join('|')) ?? 0;
        const afterPos = after.get([q.anchorId, q.positiveId].sort().join('|')) ?? 0;
        const afterNeg = after.get([q.anchorId, q.negativeId].sort().join('|')) ?? 0;

        return {
          finiteCount,
          improvedMargin: (afterPos - afterNeg) >= (beforePos - beforeNeg),
        };
      });

      if (result.improvedMargin) improved++;
    }

    console.log(`keyword fuzz improved margin ratio=${improved}/${rounds}`);
    expect(improved).toBeGreaterThan(Math.floor(rounds * 0.45));
  });

  test('scheduling random scenario benchmark (full + incremental)', () => {
    const rounds = 60;
    let validRounds = 0;

    for (let seed = 100; seed < 100 + rounds; seed++) {
      const ok = withSeed(seed, () => {
        const keywordPool = Array.from({ length: randomInt(6, 10) }, (_, i) => `k${i}`);
        const persons = makeRandomPersons(randomInt(5, 12), keywordPool);
        const config = makeRandomConfig(`cfg-${seed}`);

        const baseEmbeddings = initEmbeddings(keywordPool);
        const similarities = embeddingsToSimilarities(baseEmbeddings);

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
});
