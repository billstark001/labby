import { describe, expect, test } from 'vitest';
import type { Person, ScheduleConfig, Session, SolverInput } from '../src/types';
import { buildConstraintGuidance, buildCostContext, computeScheduleMetrics, computeScheduleQuality, validateScheduleAssignments } from '../src/schedule/index';
import { affinityPairWeight, noOverlapForbidden } from '../src/schedule/constraints';

const config: ScheduleConfig = {
  id: 'config', daysOfWeek: [1], timeRange: ['10:00', '11:00'],
  presentersPerSession: 2, questionersPerPresenter: 1, targetSimilarityRadius: 0.5,
  startDate: '2026-01-05', endDate: '2026-02-23',
};
const persons: Person[] = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id, name: id, names: { en: id }, keywordIds: [], metadata: {},
  tagIds: index < 2 ? ['local'] : ['international'],
}));
const base: SolverInput = { config, persons, similarities: { getPairSimilarity: () => undefined } };
const session = (date: string, pairs: Array<[string, string]>): Session => ({
  date, presentations: pairs.map(([presenterId, questionerId]) => ({ presenterId, questionerIds: [questionerId] })),
});
const metrics = (sessions: Session[], input: SolverInput = base) => computeScheduleMetrics({ id: 'plan', configId: config.id, createdAt: 0, sessions }, input);

describe('schedule quality objective and tag selectors', () => {
  test('a one-week repeat is more costly than an even interval for the same person', () => {
    const close = [session('2026-01-05', [['a', 'c']]), session('2026-01-12', [['a', 'd']]), session('2026-02-23', [['b', 'c']])];
    const spread = [session('2026-01-05', [['a', 'c']]), session('2026-02-02', [['a', 'd']]), session('2026-02-23', [['b', 'c']])];
    expect(metrics(close).uniformityPenalty).toBeGreaterThan(metrics(spread).uniformityPenalty);
    const report = computeScheduleQuality({ id: 'plan', configId: config.id, createdAt: 0, sessions: close }, base);
    expect(report.persons.find(person => person.personId === 'a')?.minGapDays).toBe(7);
    expect(report.persons.find(person => person.personId === 'd')?.minGapDays).toBeNull();
  });

  test('reciprocal preference changes cost direction and forbid validates', () => {
    const reciprocal = [session('2026-01-05', [['a', 'b'], ['b', 'a']])];
    const separate = [session('2026-01-05', [['a', 'b'], ['b', 'c']])];
    expect(metrics(reciprocal, { ...base, config: { ...config, reciprocalPairPreference: 'discourage' } }).reciprocalPenalty)
      .toBeGreaterThan(metrics(separate, { ...base, config: { ...config, reciprocalPairPreference: 'discourage' } }).reciprocalPenalty);
    expect(metrics(reciprocal, { ...base, config: { ...config, reciprocalPairPreference: 'encourage' } }).reciprocalPenalty).toBeLessThan(0);
    expect(validateScheduleAssignments(reciprocal, { ...base, config: { ...config, reciprocalPairPreference: 'forbid' } })).toContain('Reciprocal questioning is forbidden on 2026-01-05');
  });

  test('cross-group affinity excludes within-group pairs and follows membership changes', () => {
    const input: SolverInput = { ...base, constraints: [{ id: 'affinity', configId: config.id, type: 'affinity-boost', personIds: [], tagIds: ['local'], otherPersonIds: [], otherTagIds: ['international'], boost: 3 }] };
    const guidance = buildConstraintGuidance(buildCostContext(input));
    expect(affinityPairWeight('a', 'c', guidance)).toBe(3);
    expect(affinityPairWeight('a', 'b', guidance)).toBe(1);
    const changed = buildConstraintGuidance(buildCostContext({ ...input, persons: persons.map(person => person.id === 'c' ? { ...person, tagIds: ['local'] } : person) }));
    expect(affinityPairWeight('a', 'c', changed)).toBe(1);
  });

  test('mixed selectors and disabled membership apply to hard no-overlap', () => {
    const input: SolverInput = { ...base, persons: persons.map(person => person.id === 'd' ? { ...person, disabled: true } : person),
      constraints: [{ id: 'hard', configId: config.id, type: 'no-overlap', personIds: ['a'], tagIds: ['local'], otherPersonIds: [], otherTagIds: ['international'] }] };
    const guidance = buildConstraintGuidance(buildCostContext(input));
    expect(noOverlapForbidden('a', 'c', guidance)).toBe(true);
    expect(noOverlapForbidden('a', 'd', guidance)).toBe(false);
    expect(validateScheduleAssignments([session('2026-01-05', [['a', 'c']])], input)).toContain('No-overlap constraint violated on 2026-01-05');
  });

  test('frequency constraints contribute to the objective for tag members', () => {
    const schedule = [session('2026-01-05', [['a', 'c']]), session('2026-01-12', [['a', 'd']])];
    const withRule = { ...base, constraints: [{ id: 'frequency', configId: config.id, type: 'frequency-multiplier' as const,
      personIds: [], tagIds: ['local'], baseline: 1, multiplier: 0.25, roleScope: 'presenter' as const, weight: 5 }] };
    expect(metrics(schedule, withRule).constraintPenalty).toBeGreaterThan(metrics(schedule).constraintPenalty);
  });
});
