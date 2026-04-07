import { describe, expect, test } from 'vitest';
import type { Person, ScheduleConfig, Session, SimilarityLookup } from '../src/types.js';
import { mutatePresentations, mutateSessions } from '../src/schedule/mutation.js';

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
    { id: 'p5', name: 'P5', names: { en: 'P5' }, metadata: {}, keywordIds: ['k5'] },
    { id: 'p6', name: 'P6', names: { en: 'P6' }, metadata: {}, keywordIds: ['k6'] },
    { id: 'p7', name: 'P7', names: { en: 'P7' }, metadata: {}, keywordIds: ['k7'] },
    { id: 'p8', name: 'P8', names: { en: 'P8' }, metadata: {}, keywordIds: ['k8'] },
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
  test('delete in session-resize mode shrinks only the target session', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const result = mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'delete', sessionIndex: 0, index: 1, count: 1, mode: 'session-resize' },
    );

    expect(result[0]?.presentations.map(item => item.presenterId)).toEqual(['p1', 'p3']);
    expect(result[1]?.presentations.map(item => item.presenterId)).toEqual(['p4', 'p5', 'p6']);
  });

  test('delete in shift-chain mode pulls from next sessions and refills tail', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const result = mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'delete', sessionIndex: 0, index: 1, count: 1, mode: 'shift-chain' },
    );

    expect(result[0]?.presentations.map(item => item.presenterId)).toEqual(['p1', 'p3', 'p4']);
    expect(result[1]?.presentations[0]?.presenterId).toBe('p5');
    expect(result[1]?.presentations[1]?.presenterId).toBe('p6');
    expect(result[1]?.presentations).toHaveLength(3);
  });

  test('delete in session-refill mode refills only target session tail', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const result = mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'delete', sessionIndex: 0, index: 1, count: 1, mode: 'session-refill' },
    );

    expect(result[0]?.presentations[0]?.presenterId).toBe('p1');
    expect(result[0]?.presentations[1]?.presenterId).toBe('p3');
    expect(result[0]?.presentations).toHaveLength(3);
    expect(result[1]?.presentations.map(item => item.presenterId)).toEqual(['p4', 'p5', 'p6']);
  });

  test('insert in session-resize mode only grows target session', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const result = mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'insert', sessionIndex: 0, index: 2, count: 1, mode: 'session-resize' },
    );

    expect(result[0]?.presentations[0]?.presenterId).toBe('p1');
    expect(result[0]?.presentations[1]?.presenterId).toBe('p2');
    expect(result[0]?.presentations[3]?.presenterId).toBe('p3');
    expect(result[1]?.presentations.map(item => item.presenterId)).toEqual(['p4', 'p5', 'p6']);
  });

  test('insert in shift-chain mode cascades overflow and discards final tail overflow', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const result = mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'insert', sessionIndex: 0, index: 2, count: 1, mode: 'shift-chain' },
    );

    expect(result[0]?.presentations.map(item => item.presenterId)).toHaveLength(3);
    expect(result[0]?.presentations[0]?.presenterId).toBe('p1');
    expect(result[0]?.presentations[1]?.presenterId).toBe('p2');
    expect(result[1]?.presentations.map(item => item.presenterId)).toEqual(['p3', 'p4', 'p5']);
  });

  test('insert in session-refill mode matches shift-chain behavior', () => {
    const sessions = [
      makeSession('2026-04-01', ['p1', 'p2', 'p3']),
      makeSession('2026-04-08', ['p4', 'p5', 'p6']),
    ];

    const shifted = withSeed(42, () => mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'insert', sessionIndex: 0, index: 2, count: 1, mode: 'shift-chain' },
    ));

    const refilled = withSeed(42, () => mutatePresentations(
      sessions,
      { config: makeConfig(), persons: makePersons(), similarities: dummySimilarities },
      { operation: 'insert', sessionIndex: 0, index: 2, count: 1, mode: 'session-refill' },
    ));

    expect(refilled).toEqual(shifted);
  });
});
