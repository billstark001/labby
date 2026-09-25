import { describe, expect, test } from 'vitest';
import type { Person, ScheduleConfig, Session, SolverInput } from '../src/types.js';
import { buildConstraintGuidance, buildCostContext } from '../src/schedule/constraints.js';
import { MUTATION_WEIGHTS, mutateQuestionersOnly, mutateWithStrategies } from '../src/schedule/annealing-strategies.js';
import { repairQuestioners, targetFrequency, targetPresenterGap, targetReciprocal } from '../src/schedule/targeted-strategies.js';
import type { StrategyContext } from '../src/schedule/strategy-utils.js';

const persons: Person[] = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({
  id, name: id, names: { en: id }, keywordIds: [], metadata: {}, tagIds: [],
}));
const config: ScheduleConfig = {
  id: 'strategies', daysOfWeek: [3], timeRange: ['09:00', '11:00'],
  presentersPerSession: 2, questionersPerPresenter: 2, targetSimilarityRadius: 0.5,
  startDate: '2026-01-07', endDate: '2026-01-28',
  reciprocalPairPreference: 'discourage',
  questionerOptimization: { repair: { iterations: 5, pairWeight: 8, countWeight: 8 } },
};
const input: SolverInput = { persons, config, similarities: { getPairSimilarity: () => 0.5 } };
const sessions: Session[] = [
  { date: '2026-01-07', presentations: [
    { presenterId: 'a', questionerIds: ['d', 'c'] }, { presenterId: 'd', questionerIds: ['a', 'c'] },
  ] },
  { date: '2026-01-14', presentations: [
    { presenterId: 'a', questionerIds: ['b', 'c'] }, { presenterId: 'e', questionerIds: ['b', 'c'] },
  ] },
  { date: '2026-01-21', presentations: [
    { presenterId: 'b', questionerIds: ['a', 'c'] }, { presenterId: 'd', questionerIds: ['a', 'c'] },
  ] },
  { date: '2026-01-28', presentations: [
    { presenterId: 'b', questionerIds: ['a', 'c'] }, { presenterId: 'e', questionerIds: ['a', 'c'] },
  ] },
];

function randomSource(): () => number {
  let state = 17;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

function strategyContext(random = randomSource()): StrategyContext {
  const cost = buildCostContext(input);
  return {
    sessions, historicalSessions: [], personIds: persons.map(person => person.id),
    cost, guidance: buildConstraintGuidance(cost), config, unavailable: new Map(), random,
    pickQuestioners: presenter => persons.map(person => person.id).filter(id => id !== presenter).slice(0, 2),
  };
}

describe('schedule strategies', () => {
  test('moves and repair leave their input schedule unchanged', () => {
    const original = structuredClone(sessions);
    for (const strategy of [(state: StrategyContext) => mutateWithStrategies(state, MUTATION_WEIGHTS),
      mutateQuestionersOnly, targetFrequency, targetPresenterGap, targetReciprocal]) {
      const output = strategy(strategyContext());
      expect(output).not.toBe(sessions);
      expect(sessions).toEqual(original);
    }
    const state = strategyContext();
    repairQuestioners(sessions, [], state.cost, state.guidance, state.unavailable, state.random);
    expect(sessions).toEqual(original);
  });

  test('injected random sequence determines the selected move', () => {
    expect(mutateWithStrategies(strategyContext(randomSource()), MUTATION_WEIGHTS))
      .toEqual(mutateWithStrategies(strategyContext(randomSource()), MUTATION_WEIGHTS));
  });
});
