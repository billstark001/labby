import { describe, expect, test } from 'vitest';
import type { Person, ScheduleConfig, Session, SolverInput } from '../src/types';
import { buildConstraintGuidance, buildCostContext, computeScheduleMetrics, computeScheduleQuality, validateScheduleAssignments } from '../src/schedule/index';
import { affinityPairWeight, noOverlapForbidden, personGapCost } from '../src/schedule/constraints';

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

  test('configurable gap policy penalizes clustered appearances and reports its threshold', () => {
    const uneven = [session('2026-01-05', [['a', 'c']]), session('2026-01-12', [['a', 'd']]), session('2026-02-23', [['a', 'c']])];
    const relaxed: SolverInput = { ...base, config: { ...config, gapBalance: { presenter: { shortGapRatio: 0.2, shortGapWeight: 0, spreadWeight: 0 } } } };
    expect(metrics(uneven).uniformityPenalty).toBeGreaterThan(metrics(uneven, relaxed).uniformityPenalty);
    const report = computeScheduleQuality({ id: 'plan', configId: config.id, createdAt: 0, sessions: uneven }, relaxed);
    expect(report.shortGapRatio).toBe(0.2);
    expect(report.persons.find(person => person.personId === 'a')?.shortGapRate).toBe(0);
    expect(computeScheduleQuality({ id: 'plan', configId: config.id, createdAt: 0, sessions: uneven }, base)
      .persons.find(person => person.personId === 'a')?.shortGapRate).toBeGreaterThan(0);
    const clustered = personGapCost([0, 7, 56], -3.5, 59.5, buildCostContext(base).gapBalance.presenter);
    const balanced = personGapCost([0, 28, 56], -3.5, 59.5, buildCostContext(base).gapBalance.presenter);
    expect(clustered).toBeGreaterThan(balanced);
    expect(buildCostContext({ ...base, config: { ...config, gapBalance: { presenter: { shortGapRatio: 2, shortGapWeight: Number.NaN, spreadWeight: -4 } } } }).gapBalance.presenter)
      .toEqual({ shortGapRatio: 1, shortGapWeight: 20, spreadWeight: 0 });
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

  test('disabled constraints retain their selectors but do not affect hard or soft guidance', () => {
    const input: SolverInput = { ...base, constraints: [
      { id: 'hard', configId: config.id, type: 'no-overlap', personIds: ['a', 'c'], tagIds: [], disabled: true },
      { id: 'soft', configId: config.id, type: 'frequency-multiplier', personIds: ['a'], tagIds: [], baseline: 1, multiplier: 0.25, roleScope: 'presenter', weight: 5, disabled: true },
    ] };
    const guidance = buildConstraintGuidance(buildCostContext(input));
    expect(noOverlapForbidden('a', 'c', guidance)).toBe(false);
    expect(guidance.frequency).toHaveLength(0);
    expect(validateScheduleAssignments([session('2026-01-05', [['a', 'c']])], input)).toEqual([]);
  });

  test('frequency constraints contribute to the objective for tag members', () => {
    const schedule = [session('2026-01-05', [['a', 'c']]), session('2026-01-12', [['a', 'd']])];
    const withRule = { ...base, constraints: [{ id: 'frequency', configId: config.id, type: 'frequency-multiplier' as const,
      personIds: [], tagIds: ['local'], baseline: 1, multiplier: 0.25, roleScope: 'presenter' as const, weight: 5 }] };
    expect(metrics(schedule, withRule).constraintPenalty).toBeGreaterThan(metrics(schedule).constraintPenalty);
  });
});
