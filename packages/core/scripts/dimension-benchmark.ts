/** Run: pnpm --filter @labby/core exec tsx scripts/dimension-benchmark.ts [output.json] [seeds] [budget] */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ProductEmbeddingEngine } from '../src/embedding/engine.js';
import { initKeywordVectors } from '../src/nlp.js';
import { productDistance } from '../src/embedding/geometry.js';
import type { KeywordVector, RankingJudgment } from '../src/types.js';
import { comparisonKey, orderedGroups, rankingScenarios, seededRandom, type RankingScenario } from '../tests/support/ranking-scenario.js';

const seeds = (process.argv[3] ?? '11,29,47').split(',').map(Number);
const budget = Number(process.argv[4] ?? 30);
const configurations = [
  { dimensions: 4, selection: 'active' },
  { dimensions: 8, selection: 'active' },
  { dimensions: 16, selection: 'active' },
  { dimensions: 8, selection: 'random' },
] as const;

function distanceTable(vectors: KeywordVector[]): Map<string, number> {
  const table = new Map<string, number>();
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const distance = productDistance(vectors[i], vectors[j]);
      table.set(`${vectors[i].keywordId}|${vectors[j].keywordId}`, distance);
      table.set(`${vectors[j].keywordId}|${vectors[i].keywordId}`, distance);
    }
  }
  return table;
}

function evaluate(scenario: RankingScenario, table: Map<string, number>, excluded: Set<string>) {
  let correct = 0;
  let total = 0;
  let ties = 0;
  for (let a = 0; a < scenario.ids.length; a++) {
    for (let b = 0; b < scenario.ids.length; b++) {
      if (a === b) continue;
      for (let c = b + 1; c < scenario.ids.length; c++) {
        if (c === a || excluded.has(comparisonKey(scenario.ids[a], scenario.ids[b], scenario.ids[c]))) continue;
        const expected = scenario.distances[a][b] - scenario.distances[a][c];
        if (expected === 0) { ties++; continue; }
        const actual = table.get(`${scenario.ids[a]}|${scenario.ids[b]}`)! - table.get(`${scenario.ids[a]}|${scenario.ids[c]}`)!;
        correct += Math.abs(actual) < 1e-10 ? 0.5 : Number(actual * expected > 0);
        total++;
      }
    }
  }
  return { accuracy: correct / total, comparisons: total, excludedOracleTies: ties };
}

function historyRelations(history: RankingJudgment[]): Array<[string, string, string]> {
  return history.flatMap(j => j.groups.flatMap((group, i) =>
    group.flatMap(near => j.groups.slice(i + 1).flat().map(far => [j.anchorId, near, far] as [string, string, string]))));
}

const rows: Array<Record<string, unknown>> = [];
for (const seed of seeds) {
  for (const scenario of rankingScenarios(seed)) {
    for (const configuration of configurations) {
      const random = seededRandom(seed * 1009);
      const originalRandom = Math.random;
      Math.random = random;
      try {
        const engine = new ProductEmbeddingEngine(initKeywordVectors(scenario.ids, {
          hyperbolicDimensions: configuration.dimensions / 2,
          euclideanDimensions: configuration.dimensions / 2,
        }));
        const initial = distanceTable(engine.getVectors());
        const excluded = new Set<string>();
        const excludedQueries: string[] = [];
        let accepted = 0;
        let rejected = 0;
        let flips = 0;
        let protectedComparisons = 0;
        let history: RankingJudgment[] = [];
        let tieGroups = 0;
        const start = performance.now();
        for (let step = 0; step < budget; step++) {
          let query;
          if (configuration.selection === 'active') {
            query = engine.recommendRanking({ size: 5, excludedKeys: excludedQueries });
          } else {
            const anchorId = scenario.ids[Math.floor(random() * scenario.ids.length)];
            const pool = scenario.ids.filter(id => id !== anchorId);
            for (let i = pool.length - 1; i > 0; i--) {
              const j = Math.floor(random() * (i + 1));
              [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            query = { anchorId, candidateIds: pool.slice(0, 5), key: `random-${step}` };
          }
          if (!query) break;
          excludedQueries.push(query.key);
          const groups = orderedGroups(scenario, query.anchorId, query.candidateIds);
          tieGroups += groups.filter(group => group.length > 1).length;
          // Exclude every elicited comparison, including rejected answers and ties.
          for (let i = 0; i < query.candidateIds.length; i++) {
            for (let j = i + 1; j < query.candidateIds.length; j++) {
              excluded.add(comparisonKey(query.anchorId, query.candidateIds[i], query.candidateIds[j]));
            }
          }
          const before = distanceTable(engine.getVectors());
          const oldRelations = historyRelations(history);
          const result = engine.trainRanking({ id: `${seed}-${step}`, anchorId: query.anchorId, groups, confidence: 1, createdAt: step + 1 });
          const after = distanceTable(engine.getVectors());
          for (const [a, b, c] of oldRelations) {
            if (before.get(`${a}|${b}`)! < before.get(`${a}|${c}`)!) {
              protectedComparisons++;
              if (after.get(`${a}|${b}`)! >= after.get(`${a}|${c}`)!) flips++;
            }
          }
          history = result.history;
          if (result.accepted) accepted++; else rejected++;
        }
        const final = distanceTable(engine.getVectors());
        const baseline = evaluate(scenario, initial, excluded);
        const heldout = evaluate(scenario, final, excluded);
        const learnedRelations = historyRelations(history);
        const trainAccuracy = learnedRelations.length === 0 ? null : learnedRelations.filter(([a, b, c]) =>
          final.get(`${a}|${b}`)! < final.get(`${a}|${c}`)!).length / learnedRelations.length;
        const row = {
          seed, scenario: scenario.name, nodes: scenario.ids.length, ...configuration,
          budget, accepted, rejected, tieGroups, labeledComparisons: excluded.size,
          initialAccuracy: baseline.accuracy, ...heldout, improvement: heldout.accuracy - baseline.accuracy, trainAccuracy,
          oldRankFlips: flips, protectedComparisons, milliseconds: Math.round(performance.now() - start)
        };
        rows.push(row);
        process.stderr.write(`${JSON.stringify(row)}\n`);
      } finally { Math.random = originalRandom; }
    }
  }
}
const summary = configurations.map(configuration => {
  const matching = rows.filter(row => row.dimensions === configuration.dimensions && row.selection === configuration.selection);
  const mean = (key: string) => matching.reduce((sum, row) => sum + Number(row[key]), 0) / matching.length;
  return {
    ...configuration, runs: matching.length, meanAccuracy: mean('accuracy'), meanImprovement: mean('improvement'),
    meanAccepted: mean('accepted'), meanMilliseconds: mean('milliseconds'), totalOldRankFlips: matching.reduce((sum, row) => sum + Number(row.oldRankFlips), 0)
  };
});
const output = { methodology: '49-node synthetic shortest-path rankings; 5 candidates/query; exact oracle ties; exhaustive held-out strict comparisons exclude all elicited pairs; confidence=1; default trainer options; seed-matched initial RNG; no database.', seeds, budget, summary, rows };
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
