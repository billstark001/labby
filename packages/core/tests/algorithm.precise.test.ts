import { describe, expect, test } from 'vitest';
import {
  applyTripletStep,
  computeSimilarity,
  generateSessionDates,
  getKNearest,
  initEmbeddings,
  initPositions,
  nextTripletQuery,
  runTripletBatch,
  solveFull,
  solveIncremental,
  type EmbeddingMap,
  type PositionMap,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
  type Session,
  type SolverInput,
  type TripletQuery,
} from '../src/index.js';

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
  test('triplet learning moves positive closer than negative over batch', () => {
    // Set up deterministic embeddings: anchor 'a' at origin,
    // 'b' (negative) close to 'a', 'c' (positive) far from 'a'.
    // The query asks "a is closer to c than to b" so training should
    // pull a-c together and push a-b apart.
    const DIMS_VAL = 64;
    const aVec = new Float32Array(DIMS_VAL); // all zeros
    const bVec = new Float32Array(DIMS_VAL); bVec[0] = 0.1; // very close to a
    const cVec = new Float32Array(DIMS_VAL); cVec[0] = 1.5; // far from a

    const embeddings: EmbeddingMap = new Map([['a', aVec], ['b', bVec], ['c', cVec]]);
    const positions: PositionMap = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0.1, y: 0 }],
      ['c', { x: 1.5, y: 0 }],
    ]);
    const query: TripletQuery = { anchorId: 'a', positiveId: 'c', negativeId: 'b' };

    const beforeAC = computeSimilarity(embeddings.get('a')!, embeddings.get('c')!);
    const beforeAB = computeSimilarity(embeddings.get('a')!, embeddings.get('b')!);
    // Verify initial state: b is closer to a than c
    expect(beforeAB).toBeGreaterThan(beforeAC);

    const { embeddings: trained } = runTripletBatch(embeddings, positions, [query], 80);

    const afterAC = computeSimilarity(trained.get('a')!, trained.get('c')!);
    const afterAB = computeSimilarity(trained.get('a')!, trained.get('b')!);

    expect(afterAC).toBeGreaterThan(beforeAC);
    expect(afterAB).toBeLessThan(beforeAB);
  });

  test('computeSimilarity is symmetric', () => {
    const embeddings: EmbeddingMap = initEmbeddings(['z', 'a']);
    const simAZ = computeSimilarity(embeddings.get('z')!, embeddings.get('a')!);
    const simZA = computeSimilarity(embeddings.get('a')!, embeddings.get('z')!);
    expect(simAZ).toBeCloseTo(simZA, 10);
    expect(simAZ).toBeGreaterThan(0);
    expect(simAZ).toBeLessThanOrEqual(1);
  });

  test('nextTripletQuery returns null when keywords fewer than 3', () => {
    const em = initEmbeddings(['k1', 'k2']);
    expect(nextTripletQuery(em, ['k1', 'k2'])).toBeNull();
  });

  test('applyTripletStep is stable for missing IDs', () => {
    const embeddings: EmbeddingMap = initEmbeddings(['k1', 'k2']);
    const positions: PositionMap = initPositions(['k1', 'k2']);

    expect(() => {
      applyTripletStep(embeddings, positions, { anchorId: 'k1', positiveId: 'k2', negativeId: 'k404' });
    }).not.toThrow();
  });

  test('getKNearest returns correct number of neighbours', () => {
    const em = initEmbeddings(['a', 'b', 'c', 'd', 'e']);
    const nn = getKNearest(em, 'a', 3);
    expect(nn).toHaveLength(3);
    expect(nn.includes('a')).toBe(false);
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
});
