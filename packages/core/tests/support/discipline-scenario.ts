import { initKeywordVectors } from '../../src/nlp.js';
import type { KeywordVector, TripletQuery } from '../../src/types.js';

export type Triplet = {
  anchorId: string;
  positiveId: string;
  negativeId: string;
};

export type TripletAnswer = 'positive' | 'negative';

const LATENT_DIM = 64;

export const DISCIPLINE_KEYWORDS = [
  { id: 'linear-algebra', category: 'math' },
  { id: 'abstract-algebra', category: 'math' },
  { id: 'topology', category: 'math' },
  { id: 'deep-learning', category: 'cs' },
  { id: 'computer-vision', category: 'cs' },
  { id: 'compiler-design', category: 'cs' },
  { id: 'classical-mechanics', category: 'physics' },
  { id: 'quantum-field-theory', category: 'physics' },
  { id: 'thermodynamics', category: 'physics' },
  { id: 'genetics', category: 'biology' },
  { id: 'ecology', category: 'biology' },
  { id: 'cardiology', category: 'medicine' },
  { id: 'epidemiology', category: 'medicine' },
  { id: 'macroeconomics', category: 'economics' },
  { id: 'game-theory', category: 'economics' },
  { id: 'constitutional-law', category: 'law' },
  { id: 'syntax', category: 'linguistics' },
  { id: 'phonology', category: 'linguistics' },
  { id: 'comparative-literature', category: 'literature' },
  { id: 'medieval-literature', category: 'literature' },
  { id: 'ancient-history', category: 'history' },
  { id: 'organic-chemistry', category: 'chemistry' },
  { id: 'musicology', category: 'arts' },
] as const;

const CATEGORY_RELATION: Record<string, ReadonlySet<string>> = {
  math: new Set(['cs', 'physics', 'economics']),
  cs: new Set(['math', 'engineering']),
  physics: new Set(['math', 'chemistry']),
  biology: new Set(['medicine', 'chemistry']),
  medicine: new Set(['biology', 'statistics']),
  economics: new Set(['math', 'law']),
  law: new Set(['economics', 'history']),
  linguistics: new Set(['literature', 'history']),
  literature: new Set(['linguistics', 'history', 'arts']),
  history: new Set(['literature', 'law']),
  chemistry: new Set(['physics', 'biology']),
  arts: new Set(['literature']),
};

const CATEGORY_BY_ID = new Map<string, string>(DISCIPLINE_KEYWORDS.map((k) => [k.id, k.category]));

export function withSeed<T>(seed: number, fn: () => T): T {
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

export function initializeDisciplineVectors(seed: number): KeywordVector[] {
  const ids = DISCIPLINE_KEYWORDS.map((k) => k.id);
  const vectors = withSeed(seed, () => initKeywordVectors(ids));
  normalize(vectors);
  return vectors;
}

export function normalize(vectors: KeywordVector[]): void {
  if (vectors.length === 0) return;

  const mean = new Array<number>(LATENT_DIM).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < LATENT_DIM; i++) {
      mean[i] += v.vector64[i] ?? 0;
    }
  }
  for (let i = 0; i < LATENT_DIM; i++) {
    mean[i] /= vectors.length;
  }

  for (const v of vectors) {
    for (let i = 0; i < LATENT_DIM; i++) {
      v.vector64[i] = (v.vector64[i] ?? 0) - mean[i];
    }
  }

  let normSum = 0;
  for (const v of vectors) {
    normSum += Math.sqrt(l2Sq(v.vector64, new Array<number>(LATENT_DIM).fill(0)));
  }
  const meanNorm = normSum / vectors.length;
  if (meanNorm <= 1e-8) return;

  const scale = 1 / meanNorm;
  for (const v of vectors) {
    for (let i = 0; i < LATENT_DIM; i++) {
      v.vector64[i] = (v.vector64[i] ?? 0) * scale;
    }
    v.x = v.vector64[0] ?? 0;
    v.y = v.vector64[1] ?? 0;
  }
}

export function l2Sq(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < LATENT_DIM; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return sum;
}

function categorySimilarity(aId: string, bId: string): number {
  const ca = CATEGORY_BY_ID.get(aId);
  const cb = CATEGORY_BY_ID.get(bId);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (CATEGORY_RELATION[ca]?.has(cb) || CATEGORY_RELATION[cb]?.has(ca)) return 0.65;
  return 0.05;
}

function lexicalSimilarity(aId: string, bId: string): number {
  const aTokens = new Set(aId.split('-'));
  const bTokens = bId.split('-');
  let overlap = 0;
  for (const t of bTokens) {
    if (aTokens.has(t)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.length, 1);
}

function expectedSimilarity(aId: string, bId: string): number {
  return categorySimilarity(aId, bId) * 0.9 + lexicalSimilarity(aId, bId) * 0.1;
}

export function answerTripletBySemantics(query: TripletQuery): TripletAnswer {
  const pos = expectedSimilarity(query.anchorId, query.positiveId);
  const neg = expectedSimilarity(query.anchorId, query.negativeId);
  if (pos === neg) {
    return query.positiveId < query.negativeId ? 'positive' : 'negative';
  }
  return pos > neg ? 'positive' : 'negative';
}

export function toEffectiveTriplet(query: TripletQuery, answer: TripletAnswer): Triplet {
  return answer === 'positive'
    ? { anchorId: query.anchorId, positiveId: query.positiveId, negativeId: query.negativeId }
    : { anchorId: query.anchorId, positiveId: query.negativeId, negativeId: query.positiveId };
}

export function applyTripletStep(vectors: Map<string, KeywordVector>, triplet: Triplet, margin: number, lr: number): number {
  const a = vectors.get(triplet.anchorId);
  const b = vectors.get(triplet.positiveId);
  const c = vectors.get(triplet.negativeId);
  if (!a || !b || !c) return 0;

  const dAB = l2Sq(a.vector64, b.vector64);
  const dAC = l2Sq(a.vector64, c.vector64);
  const loss = dAB - dAC + margin;
  if (loss <= 0) return 0;

  for (let i = 0; i < LATENT_DIM; i++) {
    const xa = a.vector64[i] ?? 0;
    const xb = b.vector64[i] ?? 0;
    const xc = c.vector64[i] ?? 0;

    const ga = 2 * (xa - xb) - 2 * (xa - xc);
    const gb = 2 * (xb - xa);
    const gc = -2 * (xc - xa);

    a.vector64[i] = xa - lr * ga;
    b.vector64[i] = xb - lr * gb;
    c.vector64[i] = xc - lr * gc;
  }

  return loss;
}

export function runSupervision(vectors: KeywordVector[], supervision: Triplet[], margin = 0.2, lr = 0.03): void {
  const byId = new Map(vectors.map((v) => [v.keywordId, v]));
  for (const t of supervision) {
    void applyTripletStep(byId, t, margin, lr);
    normalize([...byId.values()]);
  }
}

export function relationSatisfied(vectors: Map<string, KeywordVector>, relation: Triplet): boolean {
  const a = vectors.get(relation.anchorId);
  const b = vectors.get(relation.positiveId);
  const c = vectors.get(relation.negativeId);
  if (!a || !b || !c) return false;
  return l2Sq(a.vector64, b.vector64) < l2Sq(a.vector64, c.vector64);
}

export function passRate(vectors: KeywordVector[], assertions: Triplet[]): number {
  const byId = new Map(vectors.map((v) => [v.keywordId, v]));
  if (assertions.length === 0) return 0;
  let pass = 0;
  for (const r of assertions) {
    if (relationSatisfied(byId, r)) pass += 1;
  }
  return pass / assertions.length;
}

export const MANUAL_SUPERVISION: Triplet[] = [
  { anchorId: 'deep-learning', positiveId: 'computer-vision', negativeId: 'medieval-literature' },
  { anchorId: 'deep-learning', positiveId: 'linear-algebra', negativeId: 'constitutional-law' },
  { anchorId: 'compiler-design', positiveId: 'linear-algebra', negativeId: 'comparative-literature' },
  { anchorId: 'linear-algebra', positiveId: 'abstract-algebra', negativeId: 'cardiology' },
  { anchorId: 'linear-algebra', positiveId: 'topology', negativeId: 'medieval-literature' },
  { anchorId: 'quantum-field-theory', positiveId: 'classical-mechanics', negativeId: 'phonology' },
  { anchorId: 'thermodynamics', positiveId: 'classical-mechanics', negativeId: 'comparative-literature' },
  { anchorId: 'genetics', positiveId: 'cardiology', negativeId: 'ancient-history' },
  { anchorId: 'epidemiology', positiveId: 'genetics', negativeId: 'musicology' },
  { anchorId: 'macroeconomics', positiveId: 'game-theory', negativeId: 'organic-chemistry' },
  { anchorId: 'constitutional-law', positiveId: 'ancient-history', negativeId: 'deep-learning' },
  { anchorId: 'syntax', positiveId: 'phonology', negativeId: 'quantum-field-theory' },
  { anchorId: 'comparative-literature', positiveId: 'medieval-literature', negativeId: 'compiler-design' },
  { anchorId: 'ancient-history', positiveId: 'medieval-literature', negativeId: 'deep-learning' },
  { anchorId: 'organic-chemistry', positiveId: 'thermodynamics', negativeId: 'comparative-literature' },
  { anchorId: 'musicology', positiveId: 'comparative-literature', negativeId: 'epidemiology' },
];

export const EVALUATION_RELATIONS: Triplet[] = [
  { anchorId: 'deep-learning', positiveId: 'computer-vision', negativeId: 'medieval-literature' },
  { anchorId: 'deep-learning', positiveId: 'linear-algebra', negativeId: 'constitutional-law' },
  { anchorId: 'linear-algebra', positiveId: 'abstract-algebra', negativeId: 'cardiology' },
  { anchorId: 'quantum-field-theory', positiveId: 'classical-mechanics', negativeId: 'phonology' },
  { anchorId: 'genetics', positiveId: 'cardiology', negativeId: 'ancient-history' },
  { anchorId: 'macroeconomics', positiveId: 'game-theory', negativeId: 'organic-chemistry' },
  { anchorId: 'syntax', positiveId: 'phonology', negativeId: 'quantum-field-theory' },
  { anchorId: 'comparative-literature', positiveId: 'medieval-literature', negativeId: 'compiler-design' },
  { anchorId: 'organic-chemistry', positiveId: 'thermodynamics', negativeId: 'comparative-literature' },
  { anchorId: 'musicology', positiveId: 'comparative-literature', negativeId: 'epidemiology' },
  { anchorId: 'epidemiology', positiveId: 'genetics', negativeId: 'musicology' },
  { anchorId: 'compiler-design', positiveId: 'deep-learning', negativeId: 'medieval-literature' },
];
