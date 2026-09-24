import {
  buildCostContext, buildConstraintGuidance,
  createSolverDiagnostics, generateSessionDates, solveFull, solveIncremental,
  validateScheduleAssignments,
} from '../src/schedule/index.js';
import { buildRandomSchedule } from '../src/schedule/annealing.js';
import { computeCostBreakdown } from '../src/schedule/constraints.js';
import { buildUnavailMap } from '../src/schedule/utils.js';
import type { Person, ScheduleConfig, ScheduleConstraint, Session, SolverInput } from '../src/types.js';

function seeded<T>(seed: number, run: () => T): T {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  try { return run(); } finally { Math.random = original; }
}

function businessMetrics(sessions: Session[], input: SolverInput) {
  const occurrences = new Map<string, number[]>();
  const questionerOccurrences = new Map<string, number[]>();
  let reciprocalPairs = 0;
  for (const session of sessions) {
    const day = Date.parse(`${session.date}T00:00:00Z`) / 86400000;
    const pairs = new Set(session.presentations.flatMap(p => p.questionerIds.map(q => `${p.presenterId}|${q}`)));
    for (const pair of pairs) {
      const [a, b] = pair.split('|');
      if (a! < b! && pairs.has(`${b}|${a}`)) reciprocalPairs++;
    }
    for (const p of session.presentations) {
      const dates = occurrences.get(p.presenterId) ?? [];
      dates.push(day);
      occurrences.set(p.presenterId, dates);
      for (const questionerId of p.questionerIds) {
        const questionerDates = questionerOccurrences.get(questionerId) ?? [];
        questionerDates.push(day);
        questionerOccurrences.set(questionerId, questionerDates);
      }
    }
  }
  const gaps = [...occurrences.values()].flatMap(dates => dates.slice(1).map((day, index) => day - dates[index]!));
  const context = buildCostContext(input);
  const cost = computeCostBreakdown(sessions, context, buildConstraintGuidance(context));
  const orderedDates = sessions.map(session => Date.parse(`${session.date}T00:00:00Z`) / 86400000).sort((a, b) => a - b);
  const spacings = orderedDates.slice(1).map((day, index) => day - orderedDates[index]!).sort((a, b) => a - b);
  const nominal = spacings[Math.floor(spacings.length / 2)] ?? 7;
  const span = orderedDates.length > 0 ? orderedDates[orderedDates.length - 1]! - orderedDates[0]! + nominal : 0;
  const measure = (byPerson: Map<string, number[]>, threshold: number) => [...byPerson.values()].filter(dates => dates.length > 1).map(dates => {
    const gaps = dates.slice(1).map((day, index) => day - dates[index]!);
    const target = span / (dates.length + 1);
    return { short: gaps.filter(gap => gap < threshold * target).length, spread: (Math.max(...gaps) - Math.min(...gaps)) / Math.max(1, target) };
  });
  const measured = measure(occurrences, 0.8);
  const questionerMeasured = measure(questionerOccurrences, 0.75);
  return { minPresenterGapDays: gaps.length ? Math.min(...gaps) : null,
    gapsUnder14Days: gaps.filter(gap => gap < 14).length, reciprocalPairs,
    hardViolations: validateScheduleAssignments(sessions, input).length,
    normalizedShortGaps: measured.reduce((sum, person) => sum + person.short, 0),
    worstGapSpread: Number(Math.max(0, ...measured.map(person => person.spread)).toFixed(2)),
    normalizedShortQuestionerGaps: questionerMeasured.reduce((sum, person) => sum + person.short, 0),
    worstQuestionerGapSpread: Number(Math.max(0, ...questionerMeasured.map(person => person.spread)).toFixed(2)),
    uniformityPenalty: Number(cost.uniformityPenalty.toFixed(2)) };
}

function scenario(name: string, people: number, endDate: string, leave = false, tags = false): SolverInput {
  const persons: Person[] = Array.from({ length: people }, (_, index) => ({
    id: `person-${index}`, name: `Person ${index}`, names: { en: `Person ${index}` },
    keywordIds: [`keyword-${index % 6}`], metadata: {},
    tagIds: [index % 2 ? 'international' : 'local', ...(index % 7 === 0 ? ['graduate'] : [])],
  }));
  const config: ScheduleConfig = { id: name, daysOfWeek: [3], timeRange: ['14:00', '16:00'],
    presentersPerSession: 2, questionersPerPresenter: 2, targetSimilarityRadius: 0.5,
    reciprocalPairPreference: 'discourage', startDate: '2026-01-07', endDate };
  const dates = generateSessionDates(config);
  const unavailabilities = leave ? persons.slice(0, Math.floor(people / 4)).map((person, index) => ({
    id: `leave-${index}`, configId: config.id, personIds: [person.id],
    startDate: dates[index * 2]!, endDate: dates[index * 2]!,
  })) : [];
  const constraints: ScheduleConstraint[] = tags ? [
    { id: 'pair', configId: config.id, type: 'affinity-boost', personIds: [], tagIds: ['local'], otherPersonIds: [], otherTagIds: ['international'], boost: 1.5 },
    { id: 'frequency', configId: config.id, type: 'frequency-multiplier', personIds: [], tagIds: ['graduate'], baseline: 1, multiplier: 0.5, roleScope: 'presenter', weight: 2 },
  ] : [];
  return { persons, config, similarities: { getPairSimilarity: () => 0.5 }, unavailabilities, constraints };
}

const scenarios = [
  scenario('small', 12, '2026-04-01'),
  scenario('medium-leave', 18, '2026-07-01', true),
  scenario('large-tags', 24, '2026-10-07', true, true),
  { ...scenario('balance-14', 14, '2026-08-05', true), constraints: [
    { id: 'reduced-frequency', type: 'frequency-multiplier' as const, configId: 'balance-14', personIds: ['person-2', 'person-9'], tagIds: [], baseline: 1, multiplier: 0.6, roleScope: 'presenter' as const, weight: 2 },
  ] },
];
const rows: unknown[] = [];
for (const input of scenarios) for (const seed of input.config.id === 'balance-14' ? [1, 2, 3, 4, 5] : [1, 2]) {
  const context = buildCostContext(input);
  const dates = generateSessionDates(input.config);
  const initial = seeded(seed, () => buildRandomSchedule([...context.personKeywords.keys()], dates,
    input.config, context, [], buildUnavailMap(input.unavailabilities ?? [], input.config.id, input.persons, dates)));
  const diagnostics = createSolverDiagnostics();
  const final = seeded(seed, () => solveFull({ ...input, diagnostics }));
  rows.push({ scenario: input.config.id, seed, initial: businessMetrics(initial, input), final: businessMetrics(final, input), search: diagnostics });
}
const incrementalInput = scenarios[1]!;
const initial = seeded(3, () => solveFull(incrementalInput));
const frozenUntil = initial[Math.floor(initial.length / 2)]!.date;
const diagnostics = createSolverDiagnostics();
const after = seeded(4, () => solveIncremental({ ...incrementalInput, sessions: initial, changeDate: frozenUntil,
  diagnostics, useHamming: true }));
rows.push({ scenario: 'incremental-frozen', seed: 4, frozenUnchanged: JSON.stringify(after.filter(s => s.date < frozenUntil)) === JSON.stringify(initial.filter(s => s.date < frozenUntil)),
  final: businessMetrics(after, incrementalInput), search: diagnostics });
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
