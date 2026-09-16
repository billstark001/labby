/** Synthetic, database-free ranking benchmarks. Distances are graph shortest paths. */
export interface RankingScenario {
  name: string;
  ids: string[];
  distances: number[][];
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function rankingScenarios(seed: number): RankingScenario[] {
  const count = 49;
  function graph(name: string, edges: Array<[number, number]>): RankingScenario {
    const distances = Array.from({ length: count }, (_, i) =>
      Array.from({ length: count }, (_, j) => i === j ? 0 : Infinity));
    for (const [a, b] of edges) distances[a][b] = distances[b][a] = 1;
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < count; j++) {
          distances[i][j] = Math.min(distances[i][j], distances[i][k] + distances[k][j]);
        }
      }
    }
    return { name, ids: Array.from({ length: count }, (_, i) => `k${i}`), distances };
  }
  const tree: Array<[number, number]> = Array.from({ length: count - 1 }, (_, i) =>
    [Math.floor(i / 2), i + 1]);
  const grid: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (i % 7 < 6) grid.push([i, i + 1]);
    if (i + 7 < count) grid.push([i, i + 7]);
  }
  const rng = seededRandom(seed);
  const communities: Array<[number, number]> = [];
  // A ring ensures connectivity; denser within-community edges add cycles.
  for (let i = 0; i < count; i++) communities.push([i, (i + 1) % count]);
  for (let i = 0; i < count; i++) {
    for (let j = i + 2; j < count; j++) {
      if (rng() < (Math.floor(i / 7) === Math.floor(j / 7) ? 0.65 : 0.015)) communities.push([i, j]);
    }
  }
  return [graph('tree', tree), graph('cross-linked-tree', [...tree, [24, 40], [30, 46], [34, 48], [25, 35], [28, 44]]),
    graph('grid', grid), graph('communities', communities)];
}

export function orderedGroups(scenario: RankingScenario, anchorId: string, candidates: string[]): string[][] {
  const anchor = scenario.ids.indexOf(anchorId);
  const byDistance = new Map<number, string[]>();
  for (const id of candidates) {
    const distance = scenario.distances[anchor][scenario.ids.indexOf(id)];
    byDistance.set(distance, [...(byDistance.get(distance) ?? []), id]);
  }
  return [...byDistance].sort(([a], [b]) => a - b).map(([, ids]) => ids.sort());
}

export function comparisonKey(anchor: string, left: string, right: string): string {
  return `${anchor}|${[left, right].sort().join('|')}`;
}
