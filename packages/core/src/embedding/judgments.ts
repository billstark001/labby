import type { RankingJudgment } from '../types.js';
export type Comparison = {
  anchor: number;
  near: number;
  far: number;
  tied: boolean;
  weight: number;
  judgmentId: string;
};

export function rankingQueryKey(anchorId: string, candidateIds: readonly string[]): string {
  return JSON.stringify([anchorId, [...candidateIds].sort()]);
}

export function validateRankingJudgment(
  judgment: RankingJudgment,
  ids?: ReadonlySet<string>,
): void {
  if (
    !judgment ||
    typeof judgment.id !== 'string' ||
    !judgment.id ||
    typeof judgment.anchorId !== 'string' ||
    !judgment.anchorId ||
    !Number.isFinite(judgment.confidence) ||
    judgment.confidence <= 0 ||
    judgment.confidence > 1 ||
    !Number.isFinite(judgment.createdAt) ||
    !Array.isArray(judgment.groups) ||
    judgment.groups.length === 0 ||
    judgment.groups.some(
      (group) =>
        !Array.isArray(group) ||
        group.length === 0 ||
        group.some((id) => typeof id !== 'string' || !id),
    )
  ) {
    throw new Error('Invalid ranking judgment');
  }
  const candidates = judgment.groups.flat();
  if (
    candidates.length < 2 ||
    candidates.length > 12 ||
    new Set(candidates).size !== candidates.length ||
    candidates.includes(judgment.anchorId)
  )
    throw new Error('Ranking requires 2–12 distinct candidates excluding the anchor');
  if (ids && [judgment.anchorId, ...candidates].some((id) => !ids.has(id)))
    throw new Error('Ranking contains unknown keywords');
}

export function buildComparisons(
  judgments: readonly RankingJudgment[],
  index: ReadonlyMap<string, number>,
): Comparison[] {
  const comparisons: Comparison[] = [];
  for (const judgment of judgments) {
    const anchor = index.get(judgment.anchorId)!;
    const groups = judgment.groups.map((group) => group.map((id) => index.get(id)!));
    const candidateCount = groups.reduce((count, group) => count + group.length, 0);
    const pairCount = (candidateCount * (candidateCount - 1)) / 2;
    // Each answer has unit total influence, independent of list size.
    const weight = judgment.confidence / pairCount;
    for (let nearRank = 0; nearRank < groups.length; nearRank++) {
      for (let farRank = nearRank; farRank < groups.length; farRank++) {
        const nearGroup = groups[nearRank]!;
        const farGroup = groups[farRank]!;
        const tied = nearRank === farRank;
        for (let nearIndex = 0; nearIndex < nearGroup.length; nearIndex++) {
          const firstFarIndex = tied ? nearIndex + 1 : 0;
          for (let farIndex = firstFarIndex; farIndex < farGroup.length; farIndex++) {
            comparisons.push({
              anchor,
              near: nearGroup[nearIndex]!,
              far: farGroup[farIndex]!,
              tied,
              weight,
              judgmentId: judgment.id,
            });
          }
        }
      }
    }
  }
  return comparisons;
}

export function findLogicalConflicts(all: readonly Comparison[]): string[] {
  // Pair-distance variables are symmetric, so cycles across different anchors are detected too.
  const pair = (a: number, b: number) => JSON.stringify(a < b ? [a, b] : [b, a]);
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let representative = key;
    while (parent.get(representative)! !== representative)
      representative = parent.get(representative)!;
    // Compress the path so repeated tie lookups do not traverse a long chain.
    while (key !== representative) {
      const next = parent.get(key)!;
      parent.set(key, representative);
      key = next;
    }
    return representative;
  };
  for (const comparison of all)
    if (comparison.tied)
      parent.set(
        root(pair(comparison.anchor, comparison.near)),
        root(pair(comparison.anchor, comparison.far)),
      );
  const edges = new Map<string, Set<string>>();
  for (const comparison of all)
    if (!comparison.tied) {
      const a = root(pair(comparison.anchor, comparison.near)),
        b = root(pair(comparison.anchor, comparison.far));
      if (a === b) return ['The ranking contradicts an existing tie.'];
      if (!edges.has(a)) edges.set(a, new Set());
      edges.get(a)!.add(b);
    }
  const indegree = new Map<string, number>();
  for (const [a, bs] of edges) {
    if (!indegree.has(a)) indegree.set(a, 0);
    for (const b of bs) indegree.set(b, (indegree.get(b) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head]!;
    visited++;
    for (const b of edges.get(a) ?? []) {
      const n = indegree.get(b)! - 1;
      indegree.set(b, n);
      if (n === 0) queue.push(b);
    }
  }
  return visited === indegree.size ? [] : ['The ranking creates a cycle with previous judgments.'];
}
