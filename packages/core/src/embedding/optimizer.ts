import type { KeywordVector, ProductGeometry, RankingJudgment, TrainingOptions } from '../types.js';
import type { Comparison } from './judgments.js';
import { distanceGradient, productStep, squaredProductDistance } from './geometry.js';

const MARGIN = 0.04;
const TIE_TOLERANCE = 0.04;
const softplus = (value: number) => Math.max(value, 0) + Math.log1p(Math.exp(-Math.abs(value)));

type OptimizationResult =
  | { accepted: false; loss: number }
  | {
      accepted: true;
      loss: number;
      positions: number[][];
      touched: Set<number>;
      maxDistanceDrift: number;
    };

type DriftPair = [moving: number, fixed: number, initialSquaredDistance: number];

interface Objective {
  geometry: ProductGeometry;
  fresh: readonly Comparison[];
  movableHistory: readonly Comparison[];
  driftPairs: readonly DriftPair[];
  historyWeight: number;
  driftWeight: number;
  fixedHistoryLoss: number;
}

/** Cache repeated pair terms within one evaluation, never across changing coordinates. */
function createObjective({
  geometry,
  fresh,
  movableHistory,
  driftPairs,
  historyWeight,
  driftWeight,
  fixedHistoryLoss,
}: Objective) {
  return (positions: number[][], withGradient: boolean): { loss: number; gradient: number[][] } => {
    const gradient = withGradient ? positions.map((v) => new Array<number>(v.length).fill(0)) : [];
    let loss = fixedHistoryLoss;
    const distances = new Map<number, number>();
    const derivatives = new Map<number, [number[], number[]]>();
    const distance = (a: number, b: number) => {
      const key = Math.min(a, b) * positions.length + Math.max(a, b);
      let value = distances.get(key);
      if (value === undefined) {
        value = squaredProductDistance(positions[a]!, positions[b]!, geometry);
        distances.set(key, value);
      }
      return value;
    };
    const accumulate = (a: number, b: number, factor: number) => {
      if (!withGradient || factor === 0) return;
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const key = left * positions.length + right;
      let derivative = derivatives.get(key);
      if (!derivative) {
        derivative = distanceGradient(positions[left]!, positions[right]!, geometry);
        derivatives.set(key, derivative);
      }
      const [gradientA, gradientB] = a === left ? derivative : [derivative[1], derivative[0]];
      for (let k = 0; k < gradientA.length; k++) {
        gradient[a]![k] += factor * gradientA[k]!;
        gradient[b]![k] += factor * gradientB[k]!;
      }
    };
    const apply = (comparison: Comparison, history: boolean) => {
      const comparisonGap =
        distance(comparison.anchor, comparison.near) - distance(comparison.anchor, comparison.far);
      const weight = comparison.weight * (history ? historyWeight : 1);
      let factor: number;
      if (comparison.tied) {
        loss += weight * comparisonGap * comparisonGap;
        factor = 2 * weight * comparisonGap;
      } else if (history) {
        const error = Math.max(0, comparisonGap + MARGIN);
        loss += weight * error * error;
        factor = 2 * weight * error;
      } else {
        const scaledGap = (comparisonGap + MARGIN) / 0.2;
        loss += weight * 0.2 * softplus(scaledGap);
        factor = weight / (1 + Math.exp(-scaledGap));
      }
      accumulate(comparison.anchor, comparison.near, factor);
      accumulate(comparison.anchor, comparison.far, -factor);
    };
    fresh.forEach((comparison) => apply(comparison, false));
    movableHistory.forEach((comparison) => apply(comparison, true));
    for (const [a, b, before] of driftPairs) {
      const error = distance(a, b) - before;
      const weight = driftWeight / Math.max(1, driftPairs.length);
      loss += weight * error * error;
      accumulate(a, b, 2 * weight * error);
    }
    return { loss, gradient };
  };
}

/** Pure optimization: callers persist coordinates and history only after acceptance. */
export function optimizeRanking(
  vectors: readonly KeywordVector[],
  geometry: ProductGeometry,
  index: ReadonlyMap<string, number>,
  judgment: RankingJudgment,
  fresh: Comparison[],
  previous: Comparison[],
  options: TrainingOptions,
): OptimizationResult {
  const gap = (positions: number[][], comparison: Comparison): number =>
    squaredProductDistance(positions[comparison.anchor]!, positions[comparison.near]!, geometry) -
    squaredProductDistance(positions[comparison.anchor]!, positions[comparison.far]!, geometry);
  const maxIterations = options.maxIterations ?? 160;
  const learningRate = options.learningRate ?? 0.3;
  const historyWeight = options.historyWeight ?? 8;
  const driftWeight = options.driftWeight ?? 0.03;
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 2000 ||
    ![learningRate, historyWeight, driftWeight].every(Number.isFinite) ||
    learningRate <= 0 ||
    learningRate > 2 ||
    historyWeight < 0 ||
    driftWeight < 0
  )
    throw new Error('Invalid training options');
  const initial = vectors.map((v) => [...v.embedding]);
  let positions = initial.map((v) => [...v]);
  const oldGaps = previous.map((comparison) => gap(initial, comparison));
  const protectedOld = previous.filter((comparison, i) =>
    comparison.tied ? Math.abs(oldGaps[i]!) <= TIE_TOLERANCE : oldGaps[i]! < 0,
  );
  // Only supervised nodes move. All untouched-to-untouched distances are exact invariants.
  const touched = new Set(
    fresh.flatMap((comparison) => [comparison.anchor, comparison.near, comparison.far]),
  );
  const driftPairs: DriftPair[] = [];
  for (const i of touched)
    for (let j = 0; j < positions.length; j++)
      if (!touched.has(j)) {
        driftPairs.push([i, j, squaredProductDistance(initial[i]!, initial[j]!, geometry)]);
      }
  // Comparisons involving only fixed nodes contribute a constant loss and no
  // usable gradient. Keep the constant so reported loss retains its meaning.
  const movableHistory = previous.filter(
    (comparison) =>
      touched.has(comparison.anchor) || touched.has(comparison.near) || touched.has(comparison.far),
  );
  const fixedHistoryLoss = previous
    .filter(
      (comparison) =>
        !touched.has(comparison.anchor) &&
        !touched.has(comparison.near) &&
        !touched.has(comparison.far),
    )
    .reduce((loss, comparison) => {
      const initialGap = gap(initial, comparison);
      const error = comparison.tied ? initialGap : Math.max(0, initialGap + MARGIN);
      return loss + comparison.weight * historyWeight * error * error;
    }, 0);
  const evaluate = createObjective({
    geometry,
    fresh,
    movableHistory,
    driftPairs,
    historyWeight,
    driftWeight,
    fixedHistoryLoss,
  });
  let current = evaluate(positions, true);
  // A collapsed migrated cluster has zero distance gradients. Separate it deterministically
  // in the Euclidean factor, without breaking any already protected comparisons.
  if (
    fresh.some((comparison) => !comparison.tied) &&
    [...touched].every((i) => current.gradient[i]!.every((v) => Math.abs(v) < 1e-14))
  ) {
    const proposal = positions.map((v) => [...v]);
    const coordinate = geometry.hyperbolicDimensions;
    judgment.groups.forEach((group, rank) =>
      group.forEach((id) => {
        proposal[index.get(id)!]![coordinate] += (rank + 1) * 0.01;
      }),
    );
    const preservesHistory = protectedOld.every((comparison) =>
      comparison.tied
        ? Math.abs(gap(proposal, comparison)) <= TIE_TOLERANCE
        : gap(proposal, comparison) < 0,
    );
    if (preservesHistory && evaluate(proposal, false).loss < current.loss) {
      positions = proposal;
      current = evaluate(positions, true);
    }
  }
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let moved = false;
    for (let backtrack = 0; backtrack < 16; backtrack++) {
      const rate = learningRate * 0.5 ** backtrack;
      const proposal = positions.map((v, i) =>
        touched.has(i) ? productStep(v, current.gradient[i]!, rate, geometry) : v,
      );
      if (!proposal.every((v) => v.every(Number.isFinite))) continue;
      if (
        protectedOld.some((comparison) =>
          comparison.tied
            ? Math.abs(gap(proposal, comparison)) > TIE_TOLERANCE
            : gap(proposal, comparison) >= 0,
        )
      )
        continue;
      const loss = evaluate(proposal, false).loss;
      if (loss > current.loss - 1e-12) continue;
      positions = proposal;
      current = evaluate(positions, true);
      moved = true;
      break;
    }
    if (!moved) break;
    if (
      fresh.every((comparison) =>
        comparison.tied
          ? Math.abs(gap(positions, comparison)) <= TIE_TOLERANCE / 2
          : gap(positions, comparison) <= -MARGIN,
      )
    )
      break;
  }
  if (
    !fresh.every((comparison) =>
      comparison.tied
        ? Math.abs(gap(positions, comparison)) <= TIE_TOLERANCE
        : gap(positions, comparison) < -1e-7,
    )
  ) {
    return { accepted: false, loss: current.loss };
  }
  let maxDistanceDrift = 0;
  for (const [a, b, before] of driftPairs)
    maxDistanceDrift = Math.max(
      maxDistanceDrift,
      Math.abs(
        Math.sqrt(squaredProductDistance(positions[a]!, positions[b]!, geometry)) -
          Math.sqrt(before),
      ),
    );
  return {
    accepted: true,
    loss: current.loss,
    positions,
    touched,
    maxDistanceDrift,
  };
}
