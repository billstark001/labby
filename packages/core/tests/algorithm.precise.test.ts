import { describe, expect, test } from 'vitest';
import {
  generateSessionDates,
  initKeywordVectors,
  keywordSimilarity,
  keywordVectorsToSimilarityMap,
  nextTripletQueryFromKeywordVectors,
  solveFull,
  solveIncremental,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
  type Session,
  type SolverInput,
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

function makeConfig(partial: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    id: 'cfg-1',
    daysOfWeek: [1, 3, 5],
    timeRange: ['14:00', '16:00'],
    presentersPerSession: 2,
    questionersPerPresenter: 2,
    targetSimilarityRadius: 0.5,
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    ...partial,
  };
}

function makePersons(): Person[] {
  return [
    {
      id: 'p1',
      name: 'P1',
      names: { en: 'P1' },
      metadata: {},
      keywordIds: ['k1', 'k2'],
    },
    {
      id: 'p2',
      name: 'P2',
      names: { en: 'P2' },
      metadata: {},
      keywordIds: ['k2', 'k3'],
    },
    {
      id: 'p3',
      name: 'P3',
      names: { en: 'P3' },
      metadata: {},
      keywordIds: ['k3', 'k4'],
    },
    {
      id: 'p4',
      name: 'P4',
      names: { en: 'P4' },
      metadata: {},
      keywordIds: ['k1', 'k4'],
    },
    {
      id: 'p5',
      name: 'P5',
      names: { en: 'P5' },
      metadata: {},
      keywordIds: ['k4'],
      disabled: true,
    },
  ];
}

function makeSimilarities(): Map<string, number> {
  return new Map([
    ['k1|k2', 0.8],
    ['k1|k3', 0.4],
    ['k1|k4', 0.3],
    ['k2|k3', 0.9],
    ['k2|k4', 0.2],
    ['k3|k4', 0.7],
  ]);
}

function assertSessionValidity(
  sessions: Session[],
  activePersonIds: Set<string>,
  unavailableByDate: Map<string, Set<string>>,
): void {
  for (const session of sessions) {
    const presenters = new Set<string>();
    for (const pres of session.presentations) {
      expect(activePersonIds.has(pres.presenterId)).toBe(true);
      expect(presenters.has(pres.presenterId)).toBe(false);
      presenters.add(pres.presenterId);

      const seenQuestioners = new Set<string>();
      for (const q of pres.questionerIds) {
        expect(activePersonIds.has(q)).toBe(true);
        expect(q).not.toBe(pres.presenterId);
        expect(seenQuestioners.has(q)).toBe(false);
        expect(unavailableByDate.get(session.date)?.has(q) ?? false).toBe(false);
        seenQuestioners.add(q);
      }

      expect(unavailableByDate.get(session.date)?.has(pres.presenterId) ?? false).toBe(false);
    }
  }
}

function collectUnavailable(configId: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (date: string, personId: string) => {
    if (!map.has(date)) map.set(date, new Set());
    map.get(date)?.add(personId);
  };

  if (configId === 'cfg-1') {
    add('2026-04-03', 'p2');
    add('2026-04-03', 'p3');
    add('2026-04-03', 'p4');
    add('2026-04-07', 'p1');
  }
  return map;
}

describe('Keyword distance algorithm (black-box precise tests)', () => {
  test('similarity map key is normalized regardless of insertion order', () => {
    const vectors = [
      {
        keywordId: 'z',
        vector64: Array.from({ length: 64 }, () => 0),
        x: 0,
        y: 0,
        updatedAt: 0,
      },
      {
        keywordId: 'a',
        vector64: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
        x: 1,
        y: 0,
        updatedAt: 0,
      },
    ];

    const sim = keywordVectorsToSimilarityMap(vectors);
    expect(sim.has('a|z')).toBe(true);
    expect(sim.has('z|a')).toBe(false);
    const value = sim.get('a|z') ?? 0;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  test('nextTripletQuery returns null when vectors fewer than 3', () => {
    const vectors = initKeywordVectors(['k1', 'k2']);
    expect(nextTripletQueryFromKeywordVectors(vectors)).toBeNull();
  });

  test('keyword similarity stays within (0,1]', () => {
    const vectors = initKeywordVectors(['k1', 'k2']);
    const [a, b] = vectors;
    const s = keywordSimilarity(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test('64D vectors satisfy metric axioms on larger point set', () => {
    const vectors = withSeed(2026, () => initKeywordVectors(
      Array.from({ length: 96 }, (_, i) => `k-${i}`),
    ));

    const l2 = (va: number[], vb: number[]) => {
      let sum = 0;
      for (let i = 0; i < 64; i++) {
        const d = (va[i] ?? 0) - (vb[i] ?? 0);
        sum += d * d;
      }
      return Math.sqrt(sum);
    };

    for (let i = 0; i < 180; i++) {
      const a = vectors[(i * 17) % vectors.length];
      const b = vectors[(i * 31 + 7) % vectors.length];
      const c = vectors[(i * 47 + 13) % vectors.length];
      if (!a || !b || !c) continue;

      const dAB = l2(a.vector64, b.vector64);
      const dBA = l2(b.vector64, a.vector64);
      const dAC = l2(a.vector64, c.vector64);
      const dBC = l2(b.vector64, c.vector64);

      expect(dAB).toBeGreaterThanOrEqual(0);
      expect(Math.abs(dAB - dBA)).toBeLessThan(1e-6);
      expect(dAC).toBeLessThanOrEqual(dAB + dBC + 1e-6);
    }
  });

  test('triplet query selection remains valid under dense pair graph', () => {
    const vectors = withSeed(99, () => initKeywordVectors(
      Array.from({ length: 120 }, (_, i) => `node-${i}`),
    ));
    const recent = new Set<string>();

    for (let i = 0; i < 32; i++) {
      const q = nextTripletQueryFromKeywordVectors(vectors, recent);
      expect(q).not.toBeNull();
      if (!q) continue;
      expect(q.anchorId).not.toBe(q.positiveId);
      expect(q.anchorId).not.toBe(q.negativeId);
      expect(q.positiveId).not.toBe(q.negativeId);
      const pair = [q.anchorId, q.positiveId].sort().join('|');
      recent.add(pair);
    }
  });
});

describe('Scheduling algorithm (black-box precise tests)', () => {
  test('generateSessionDates keeps only configured weekdays in UTC', () => {
    const config = makeConfig({
      daysOfWeek: [1, 5],
      startDate: '2026-04-01',
      endDate: '2026-04-10',
    });

    const dates = generateSessionDates(config);
    expect(dates).toEqual(['2026-04-03', '2026-04-06', '2026-04-10']);
  });

  test('full solver respects disabled users and availability constraints', () => {
    const persons = makePersons();
    const config = makeConfig({
      startDate: '2026-04-01',
      endDate: '2026-04-08',
      daysOfWeek: [1, 3, 5],
    });
    const unavailable = [
      {
        id: 'u1',
        personId: 'p2',
        configId: config.id,
        startDate: '2026-04-03',
        endDate: '2026-04-03',
      },
      {
        id: 'u2',
        personId: 'p3',
        configId: config.id,
        startDate: '2026-04-03',
        endDate: '2026-04-03',
      },
      {
        id: 'u3',
        personId: 'p4',
        configId: config.id,
        startDate: '2026-04-03',
        endDate: '2026-04-03',
      },
    ];

    const input: SolverInput = {
      persons,
      similarities: makeSimilarities(),
      config,
      unavailabilities: unavailable,
    };

    const plan = withSeed(7, () => solveFull(input));
    const activePersonIds = new Set(persons.filter(p => !p.disabled).map(p => p.id));
    const unavailableByDate = collectUnavailable(config.id);

    assertSessionValidity(plan.sessions, activePersonIds, unavailableByDate);

    const target = plan.sessions.find(s => s.date === '2026-04-03');
    expect(target).toBeDefined();
    expect(target?.presentations.some(p => p.presenterId === 'p2' || p.presenterId === 'p3' || p.presenterId === 'p4')).toBe(false);
  });

  test('incremental solver keeps sessions before changeDate unchanged', () => {
    const persons = makePersons();
    const config = makeConfig({
      startDate: '2026-04-01',
      endDate: '2026-04-24',
      daysOfWeek: [1, 5],
    });
    const baseInput: SolverInput = {
      persons,
      similarities: makeSimilarities(),
      config,
    };

    const previousPlan: SchedulePlan = withSeed(11, () => solveFull(baseInput));
    const changeDate = '2026-04-13';

    const next = withSeed(12, () =>
      solveIncremental({
        ...baseInput,
        previousPlan,
        changeDate,
      }),
    );

    const frozenPrev = previousPlan.sessions.filter(s => s.date < changeDate);
    const frozenNext = next.sessions.filter(s => s.date < changeDate);
    expect(frozenNext).toEqual(frozenPrev);
  });

  test('frequency-multiplier constraint is accepted with configurable role scopes', () => {
    const persons = makePersons();
    const config = makeConfig({
      startDate: '2026-04-01',
      endDate: '2026-04-20',
      daysOfWeek: [1, 3, 5],
      presentersPerSession: 2,
      questionersPerPresenter: 1,
    });

    const constraints = [
      {
        id: 'constraint-frequency-test',
        configId: config.id,
        type: 'frequency-multiplier' as const,
        personIds: ['p1', 'p2'],
        baseline: 2,
        multiplier: 1.5,
        roleScope: 'both' as const,
        weight: 1,
      },
    ];

    const plan = withSeed(42, () => solveFull({
      persons,
      similarities: makeSimilarities(),
      config,
      constraints,
    }));

    expect(plan.sessions.length).toBeGreaterThan(0);
    const appearances = new Map<string, number>();
    for (const session of plan.sessions) {
      for (const presentation of session.presentations) {
        appearances.set(presentation.presenterId, (appearances.get(presentation.presenterId) ?? 0) + 1);
        for (const questionerId of presentation.questionerIds) {
          appearances.set(questionerId, (appearances.get(questionerId) ?? 0) + 1);
        }
      }
    }
    expect((appearances.get('p1') ?? 0) + (appearances.get('p2') ?? 0)).toBeGreaterThan(0);
  });

  test('optimizer applies no-overlap, affinity-boost, and frequency-multiplier together', () => {
    const persons: Person[] = [1, 2, 3, 4].map(i => ({
      id: `p${i}`,
      name: `P${i}`,
      names: { en: `P${i}` },
      metadata: {},
      keywordIds: [`k${i}`],
    }));

    const config = makeConfig({
      startDate: '2026-04-01',
      endDate: '2026-04-20',
      daysOfWeek: [1, 3, 5],
      presentersPerSession: 1,
      questionersPerPresenter: 1,
      targetSimilarityRadius: 0.5,
    });

    const similarities = new Map<string, number>([
      ['k1|k2', 0.5],
      ['k1|k3', 0.1],
      ['k1|k4', 0.1],
      ['k2|k3', 0.1],
      ['k2|k4', 0.1],
      ['k3|k4', 0.5],
    ]);

    const constraints = [
      {
        id: 'constraint-no-overlap',
        configId: config.id,
        type: 'no-overlap' as const,
        personIds: ['p1', 'p2'],
        weight: 50,
      },
      {
        id: 'constraint-affinity',
        configId: config.id,
        type: 'affinity-boost' as const,
        personIds: ['p3', 'p4'],
        boost: 4,
      },
      {
        id: 'constraint-frequency',
        configId: config.id,
        type: 'frequency-multiplier' as const,
        personIds: ['p3'],
        baseline: 2,
        multiplier: 2,
        roleScope: 'both' as const,
        weight: 8,
      },
    ];

    const plan = withSeed(2026, () => solveFull({
      persons,
      similarities,
      config,
      constraints,
    }));

    let noOverlapViolations = 0;
    let affinityPairings = 0;
    let p3Appearances = 0;

    for (const session of plan.sessions) {
      for (const presentation of session.presentations) {
        if (presentation.presenterId === 'p3') p3Appearances++;
        for (const q of presentation.questionerIds) {
          if (q === 'p3') p3Appearances++;
          if (
            (presentation.presenterId === 'p1' || presentation.presenterId === 'p2')
            && (q === 'p1' || q === 'p2')
          ) {
            noOverlapViolations++;
          }
          if (
            (presentation.presenterId === 'p3' || presentation.presenterId === 'p4')
            && (q === 'p3' || q === 'p4')
          ) {
            affinityPairings++;
          }
        }
      }
    }

    expect(noOverlapViolations).toBe(0);
    expect(affinityPairings).toBeGreaterThan(0);
    expect(p3Appearances).toBeGreaterThanOrEqual(4);
  });
});
