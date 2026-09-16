import type { KeywordVector, ProductGeometry, RankingJudgment, RankingQuery } from '../types.js';
import type { GraphSnapshotEdge } from '../db.js';
import { productDistanceMatrix } from './geometry.js';
import { rankingQueryKey, type Comparison } from './judgments.js';
export function selectRanking(
  vectors: readonly KeywordVector[],
  history: readonly RankingJudgment[],
  index: ReadonlyMap<string, number>,
  geometry: ProductGeometry,
  comparisons: readonly Comparison[],
  options: { size?: number; excludedKeys?: string[] },
): RankingQuery | null {
  if (
    options.size !== undefined &&
    (!Number.isInteger(options.size) || options.size < 2 || options.size > 8)
  )
    throw new Error('Invalid ranking list size');
  if (vectors.length < 3) return null;
  const size = Math.min(
    vectors.length - 1,
    Math.max(2, Math.min(8, Math.floor(options.size ?? 5))),
  );
  const excluded = new Set(options.excludedKeys ?? []);
  const asked = new Map<number, number>();
  const known = new Set<number>();
  const comparisonKey = (anchor: number, left: number, right: number) =>
    (anchor * vectors.length + Math.min(left, right)) * vectors.length + Math.max(left, right);
  for (const j of history) {
    const anchorIndex = index.get(j.anchorId)!;
    asked.set(anchorIndex, (asked.get(anchorIndex) ?? 0) + 1);
  }
  for (const comparison of comparisons)
    known.add(comparisonKey(comparison.anchor, comparison.near, comparison.far));
  // Bounded candidate pool, coverage + entropy + factor disagreement (a heuristic, not calibrated MI).
  const matrix = productDistanceMatrix(vectors);
  let best: { query: RankingQuery; score: number } | undefined;
  for (let anchorIndex = 0; anchorIndex < vectors.length; anchorIndex++) {
    const anchorDistances = matrix[anchorIndex]!;
    const neighbors = vectors
      .map((_, i) => i)
      .filter((i) => i !== anchorIndex)
      .sort((i, j) => anchorDistances[i]! - anchorDistances[j]! || i - j);
    const euclidean = vectors.map((vector) => {
      let squared = 0;
      for (
        let coordinate = geometry.hyperbolicDimensions;
        coordinate < vector.embedding.length;
        coordinate++
      ) {
        squared +=
          (vectors[anchorIndex]!.embedding[coordinate]! - vector.embedding[coordinate]!) ** 2;
      }
      return squared;
    });
    const gains = new Map<number, number>();
    const gain = (leftIndex: number, rightIndex: number) => {
      if (known.has(comparisonKey(anchorIndex, leftIndex, rightIndex))) return -0.5;
      const pairKey =
        Math.min(leftIndex, rightIndex) * vectors.length + Math.max(leftIndex, rightIndex);
      const cached = gains.get(pairKey);
      if (cached !== undefined) return cached;
      const gap = anchorDistances[leftIndex]! - anchorDistances[rightIndex]!;
      const probability = 1 / (1 + Math.exp(gap / 0.5));
      const entropy =
        -probability * Math.log(probability + 1e-12) -
        (1 - probability) * Math.log(1 - probability + 1e-12);
      const euclideanGap = euclidean[leftIndex]! - euclidean[rightIndex]!;
      const hyperbolicGap =
        2 * (anchorDistances[leftIndex]! ** 2 - anchorDistances[rightIndex]! ** 2) - euclideanGap;
      const value = 1 + entropy + (hyperbolicGap * euclideanGap < 0 ? 0.25 : 0);
      gains.set(pairKey, value);
      return value;
    };
    for (let trial = 0; trial < 4; trial++) {
      const offset = (asked.get(anchorIndex) ?? 0) * 7 + trial * 13 + excluded.size * 3;
      const pool = [
        ...new Set([
          ...neighbors.slice(0, 16),
          ...Array.from(
            { length: Math.min(48, neighbors.length) },
            (_, k) =>
              neighbors[
                (Math.floor((k * neighbors.length) / Math.min(48, neighbors.length)) + offset) %
                  neighbors.length
              ]!,
          ),
        ]),
      ];
      const selected: number[] = [
        neighbors[(offset + Math.floor((trial * neighbors.length) / 4)) % neighbors.length]!,
      ];
      while (selected.length < size) {
        let winner = -1,
          bestGain = -Infinity;
        for (const candidate of pool)
          if (!selected.includes(candidate)) {
            const score = selected.reduce((sum, leftIndex) => sum + gain(leftIndex, candidate), 0);
            if (score > bestGain) {
              bestGain = score;
              winner = candidate;
            }
          }
        if (winner < 0) break;
        selected.push(winner);
      }
      const ids = selected.map((i) => vectors[i]!.keywordId);
      const query = {
        anchorId: vectors[anchorIndex]!.keywordId,
        candidateIds: ids,
        key: rankingQueryKey(vectors[anchorIndex]!.keywordId, ids),
      };
      if (excluded.has(query.key)) continue;
      let score = 0,
        unknownCount = 0;
      for (let i = 0; i < selected.length; i++)
        for (let j = i + 1; j < selected.length; j++) {
          const leftIndex = selected[i]!,
            rightIndex = selected[j]!;
          if (known.has(comparisonKey(anchorIndex, leftIndex, rightIndex))) continue;
          unknownCount++;
          score += gain(leftIndex, rightIndex) - 0.5;
        }
      if (!unknownCount) continue;
      score /= 1 + (asked.get(anchorIndex) ?? 0);
      if (!best || score > best.score) best = { query, score };
    }
  }
  if (!best) return null;
  // Stable lexical presentation does not suggest the model's preferred answer.
  best.query.candidateIds.sort();
  return best.query;
}
export function buildSimilarityGraphEdges(
  vectors: readonly KeywordVector[],
  neighbors = 4,
): GraphSnapshotEdge[] {
  const edges = new Map<string, GraphSnapshotEdge>();
  const matrix = productDistanceMatrix(vectors);
  for (let sourceIndex = 0; sourceIndex < vectors.length; sourceIndex++) {
    const source = vectors[sourceIndex]!;
    const nearest = vectors
      .map((target, targetIndex) => ({
        id: target.keywordId,
        distance: matrix[sourceIndex]![targetIndex]!,
      }))
      .filter((target) => target.id !== source.keywordId)
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    for (const target of nearest.slice(0, Math.max(0, neighbors))) {
      const [sourceId, targetId] = [source.keywordId, target.id].sort() as [string, string];
      edges.set(JSON.stringify([sourceId, targetId]), {
        sourceId,
        targetId,
        weight: 1 / (1 + target.distance),
      });
    }
  }
  return [...edges.values()];
}
