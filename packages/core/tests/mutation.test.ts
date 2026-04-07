import { describe, expect, test } from 'vitest';
import type { Person, ScheduleConfig, Session, SimilarityLookup } from '../src/types.js';
import { mutatePresentations, mutateSessions } from '../src/schedule/mutation.js';

function makeConfig(): ScheduleConfig {
  return {
    id: 'cfg-mutation',
    daysOfWeek: [1],
    timeRange: ['14:00', '16:00'],
    presentersPerSession: 3,
    questionersPerPresenter: 1,
    targetSimilarityRadius: 0.5,
    startDate: '2026-04-01',
    endDate: '2026-04-30',
  };
}

function makePersons(): Person[] {
  return [
    { id: 'p1', name: 'P1', names: { en: 'P1' }, metadata: {}, keywordIds: ['k1'] },
    { id: 'p2', name: 'P2', names: { en: 'P2' }, metadata: {}, keywordIds: ['k2'] },
    { id: 'p3', name: 'P3', names: { en: 'P3' }, metadata: {}, keywordIds: ['k3'] },
    { id: 'p4', name: 'P4', names: { en: 'P4' }, metadata: {}, keywordIds: ['k4'] },
  ];
}

const dummySimilarities: SimilarityLookup = {
  getPairSimilarity: () => 0.5,
};

function makeSession(date: string, presenters: string[]): Session {
  return {
    date,
    presentations: presenters.map(id => ({
      presenterId: id,
      questionerIds: presenters.filter(x => x !== id).slice(0, 1),
    })),
  };
}

describe('mutateSessions', () => {
  test('shift insertion appends generated sessions at the end', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1']),
      makeSession('2026-04-08', ['p2']),
    ];

    const result = mutateSessions(
      sessions,
      {
        config: makeConfig(),
        persons: makePersons(),
        similarities: dummySimilarities,
      },
      {
        operation: 'insert',
        index: 0,
        dates: ['2026-04-15'],
        tactic: 'shift',
      },
    );

    expect(result.sessions.map(s => s.date)).toEqual([
      '2026-04-01',
      '2026-04-08',
      '2026-04-15',
    ]);
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]?.action).toBe('insert');
    expect(result.mutations[0]?.date).toBe('2026-04-15');
  });

  test('shift deletion removes sessions from tail and merges mutation records', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1']),
      makeSession('2026-04-08', ['p2']),
      makeSession('2026-04-15', ['p3']),
    ];

    const result = mutateSessions(
      sessions,
      {
        config: makeConfig(),
        persons: makePersons(),
        similarities: dummySimilarities,
        mutations: [{ date: '2026-03-25', action: 'insert', createdAt: 1 }],
      },
      {
        operation: 'delete',
        index: 0,
        count: 1,
        tactic: 'shift',
      },
    );

    expect(result.sessions.map(s => s.date)).toEqual([
      '2026-04-01',
      '2026-04-08',
    ]);
    expect(result.mutations.map(m => `${m.action}:${m.date}`)).toEqual([
      'insert:2026-03-25',
      'delete:2026-04-15',
    ]);
  });

  test('keep insertion inserts at index and preserves surrounding order', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1']),
      makeSession('2026-04-08', ['p2']),
    ];

    const result = mutateSessions(
      sessions,
      {
        config: makeConfig(),
        persons: makePersons(),
        similarities: dummySimilarities,
      },
      {
        operation: 'insert',
        index: 1,
        dates: ['2026-04-03', '2026-04-05'],
        tactic: 'keep',
      },
    );

    expect(result.sessions.map(s => s.date)).toEqual([
      '2026-04-01',
      '2026-04-03',
      '2026-04-05',
      '2026-04-08',
    ]);
  });
});

describe('mutatePresentations', () => {
  test('keep insertion inserts generated presentations at index', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2']),
    ];

    const result = mutatePresentations(
      sessions,
      {
        config: makeConfig(),
        persons: makePersons(),
        similarities: dummySimilarities,
      },
      {
        operation: 'insert',
        sessionIndex: 0,
        index: 1,
        count: 1,
        tactic: 'keep',
      },
    );

    expect(result[0]?.presentations).toHaveLength(3);
    expect(result[0]?.presentations[0]?.presenterId).toBe('p1');
    expect(result[0]?.presentations[2]?.presenterId).toBe('p2');
  });

  test('shift deletion with fixed length removes tail then refills', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
    ];

    const result = mutatePresentations(
      sessions,
      {
        config: makeConfig(),
        persons: makePersons(),
        similarities: dummySimilarities,
      },
      {
        operation: 'delete',
        sessionIndex: 0,
        index: 0,
        count: 1,
        tactic: 'shift',
        changeSessionLength: false,
      },
    );

    expect(result[0]?.presentations).toHaveLength(3);
    expect(result[0]?.presentations[0]?.presenterId).toBe('p1');
    expect(result[0]?.presentations[1]?.presenterId).toBe('p2');
  });
});
