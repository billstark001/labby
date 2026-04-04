import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EVALUATION_RELATIONS,
  answerTripletBySemantics,
  initializeDisciplineVectors,
  normalize,
  passRate,
  runSupervision,
  toEffectiveTriplet,
  type Triplet,
} from '../tests/support/discipline-scenario.js';
import { nextTripletQueryFromKeywordVectors } from '../src/nlp.js';

interface TraceItem {
  step: number;
  query: {
    anchorId: string;
    positiveId: string;
    negativeId: string;
  };
  answer: 'positive' | 'negative';
  effective: Triplet;
}

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function main() {
  const seed = Number.parseInt(parseArg('--seed', '20260404'), 10);
  const rounds = Number.parseInt(parseArg('--rounds', '80'), 10);
  const outPathArg = parseArg('--out', 'tests/fixtures/recommended-supervision.json');

  const vectors = initializeDisciplineVectors(seed);
  const recentPairs = new Set<string>();
  const supervision: Triplet[] = [];
  const trace: TraceItem[] = [];

  for (let step = 0; step < rounds; step++) {
    const query = nextTripletQueryFromKeywordVectors(vectors, recentPairs);
    if (!query) break;

    const answer = answerTripletBySemantics(query);
    const effective = toEffectiveTriplet(query, answer);
    supervision.push(effective);
    trace.push({
      step: step + 1,
      query: {
        anchorId: query.anchorId,
        positiveId: query.positiveId,
        negativeId: query.negativeId,
      },
      answer,
      effective,
    });

    runSupervision(vectors, [effective]);
    normalize(vectors);

    const left = query.anchorId < query.positiveId ? query.anchorId : query.positiveId;
    const right = query.anchorId < query.positiveId ? query.positiveId : query.anchorId;
    recentPairs.add(`${left}|${right}`);
  }

  const rate = passRate(vectors, EVALUATION_RELATIONS);
  const outPath = path.resolve(process.cwd(), outPathArg);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(supervision, null, 2)}\n`, 'utf8');

  console.log(`seed=${seed} rounds=${rounds}`);
  console.log(`supervision.length=${supervision.length}`);
  console.log(`evaluation.passRate=${rate.toFixed(4)}`);
  console.log('trace.sample=');
  for (const item of trace.slice(0, 10)) {
    console.log(
      `${item.step}. anchor=${item.query.anchorId} ` +
      `cand=(${item.query.positiveId}, ${item.query.negativeId}) answer=${item.answer}`,
    );
  }
  console.log(`written=${outPath}`);
}

main();
