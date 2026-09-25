/** Reproducible, synthetic comparison of the three questioner tuning controls. */
import { performance } from 'node:perf_hooks';
import { buildCostContext, buildConstraintGuidance, COST_WEIGHTS, generateSessionDates, solveFull, validateScheduleAssignments } from '../src/schedule/index.js';
import { computeCostBreakdown, weightedTotalCost } from '../src/schedule/constraints.js';
import type { Person, ScheduleConfig, ScheduleConstraint, Session, SolverInput } from '../src/types.js';

function seeded<T>(seed: number, action: () => T): T {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 0x100000000);
  try { return action(); } finally { Math.random = original; }
}

function scenario(id: string, people: number, weeks: number, weighted: boolean): SolverInput {
  const persons: Person[] = Array.from({ length: people }, (_, n) => ({
    id: `p${n}`, name: `Person ${n}`, names: { en: `Person ${n}` },
    keywordIds: [`k${n % 5}`], metadata: {}, tagIds: [],
  }));
  const start = new Date('2026-01-07T00:00:00Z');
  const end = new Date(start.getTime() + (weeks - 1) * 7 * 86400000).toISOString().slice(0, 10);
  const config: ScheduleConfig = {
    id, daysOfWeek: [3], timeRange: ['09:00', '11:00'], presentersPerSession: 2,
    questionersPerPresenter: 2, targetSimilarityRadius: 0.5,
    reciprocalPairPreference: 'discourage', startDate: '2026-01-07', endDate: end,
  };
  const constraints: ScheduleConstraint[] = weighted ? [{
    id: 'reduced', configId: id, type: 'frequency-multiplier', personIds: ['p1', 'p5'],
    tagIds: [], baseline: 1, multiplier: 0.6, roleScope: 'presenter', weight: 2,
  }] : [];
  const dates = generateSessionDates(config);
  const unavailabilities = weighted ? persons.slice(0, 3).map((person, n) => ({
    id: `leave-${n}`, configId: id, personIds: [person.id],
    startDate: dates[3 + n * 4]!, endDate: dates[3 + n * 4]!,
  })) : [];
  return { persons, config, constraints, unavailabilities,
    similarities: { getPairSimilarity: () => 0.5 } };
}

const variants = {
  baseline: {},
  assignment: { questionerOptimization: { assignment: { noveltyChance: 0.85, balanceChance: 0.85 } } },
  repair: { questionerOptimization: { repair: { iterations: 30, pairWeight: 8, countWeight: 8 } } },
  combined: { questionerOptimization: {
    assignment: { noveltyChance: 0.85, balanceChance: 0.85 },
    repair: { iterations: 30, pairWeight: 8, countWeight: 8 },
  } },
  pairWeight2: { costWeights: { questionerPair: 2 } },
  pairWeight4: { costWeights: { questionerPair: 4 } },
  reciprocalWeight2: { costWeights: { reciprocal: 2 } },
  weights: { costWeights: { questionerPair: 10, questionerCount: 24, questionerGap: 4 } },
} satisfies Record<string, Partial<ScheduleConfig>>;

function measure(sessions: Session[], input: SolverInput) {
  const counts = new Map(input.persons.map(person => [person.id, 0]));
  const pairs = new Map<string, number>();
  for (const session of sessions) for (const presentation of session.presentations)
    for (const id of presentation.questionerIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const pair = `${id}→${presentation.presenterId}`;
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  const ctx = buildCostContext({ ...input, config: { ...input.config, costWeights: undefined } });
  const breakdown = computeCostBreakdown(sessions, ctx, buildConstraintGuidance(ctx));
  const values = [...counts.values()];
  return {
    repeatedPairExcess: [...pairs.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    maxPairUses: Math.max(0, ...pairs.values()),
    questionCountRange: Math.max(...values) - Math.min(...values),
    questionCountVariance: Number(breakdown.questionerCountPenalty.toFixed(2)),
    repeatedPairPenalty: Number(breakdown.questionerPenalty.toFixed(2)),
    reciprocalPenalty: Number(breakdown.reciprocalPenalty.toFixed(2)),
    questionGapPenalty: Number(breakdown.questionerGapPenalty.toFixed(2)),
    presenterGapPenalty: Number(breakdown.uniformityPenalty.toFixed(2)),
    defaultWeightedCost: Number(weightedTotalCost(breakdown, COST_WEIGHTS).toFixed(2)),
    hardViolations: validateScheduleAssignments(sessions, input).length,
  };
}

const inputs = [scenario('14-people-31-weeks', 14, 31, false), scenario('14-people-weighted-leave', 14, 31, true)];
for (const input of inputs) for (const [variant, changes] of Object.entries(variants)) {
  const rows = [];
  for (const seed of [1, 2, 3]) {
    const configured = { ...input, config: { ...input.config, ...changes } };
    const started = performance.now();
    const result = seeded(seed, () => solveFull(configured));
    rows.push({ seed, durationMs: Math.round(performance.now() - started), ...measure(result, configured) });
  }
  const means = Object.fromEntries(Object.keys(rows[0]!).filter(key => key !== 'seed').map(key => [key,
    Number((rows.reduce((sum, row) => sum + Number(row[key as keyof typeof row]), 0) / rows.length).toFixed(2))]));
  process.stdout.write(`${JSON.stringify({ scenario: input.config.id, variant, means, rows })}\n`);
}
