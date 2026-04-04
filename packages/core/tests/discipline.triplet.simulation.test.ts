import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  EVALUATION_RELATIONS,
  MANUAL_SUPERVISION,
  initializeDisciplineVectors,
  normalize,
  passRate,
  runSupervision,
  type Triplet,
} from './support/discipline-scenario.js';

function loadRecommendedSupervision(): Triplet[] {
  const url = new URL('./fixtures/recommended-supervision.json', import.meta.url);
  const raw = readFileSync(url, 'utf8');
  const data = JSON.parse(raw) as Triplet[];
  return data;
}

describe('Discipline keyword triplet simulation', () => {
  test('manual vs engine-recommended supervision share comparable pass-rate criteria', () => {
    const recommended = loadRecommendedSupervision();

    const manualVectors = initializeDisciplineVectors(20260404);
    runSupervision(manualVectors, MANUAL_SUPERVISION, 0.2, 0.03);
    normalize(manualVectors);

    const recommendedVectors = initializeDisciplineVectors(20260404);
    runSupervision(recommendedVectors, recommended, 0.2, 0.03);
    normalize(recommendedVectors);

    const manualRate = passRate(manualVectors, EVALUATION_RELATIONS);
    const recommendedRate = passRate(recommendedVectors, EVALUATION_RELATIONS);

    // Same metric standards for both supervision modes.
    const passThreshold = 2 / 3;
    expect(manualRate).toBeGreaterThanOrEqual(passThreshold);
    expect(recommendedRate).toBeGreaterThanOrEqual(passThreshold);
    expect(Math.abs(manualRate - recommendedRate)).toBeLessThanOrEqual(0.30);
  });
});
