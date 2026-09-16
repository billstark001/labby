/** Group assignments are independent of display order; rank 0 means unknown. */
export function rankingGroups(
  candidateIds: readonly string[],
  ranks: Readonly<Record<string, number>>,
): string[][] {
  const groups = new Map<number, string[]>();
  for (const id of candidateIds) {
    const rank = ranks[id] ?? 0;
    if (!Number.isInteger(rank) || rank < 0 || rank > candidateIds.length)
      throw new Error('Invalid rank');
    if (!rank) continue;
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank)!.push(id);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([, ids]) => ids);
}

/** A move expresses one relative judgment. Untouched unknown candidates stay unknown. */
export function moveRanking(
  candidates: readonly string[],
  ranks: Readonly<Record<string, number>>,
  source: string,
  target: string,
  placement: 'before' | 'after',
): Record<string, number> {
  if (source === target || !candidates.includes(source) || !candidates.includes(target))
    return { ...ranks };
  const groups = rankingGroups(candidates, ranks)
    .map((group) => group.filter((id) => id !== source))
    .filter((group) => group.length);
  if (!groups.some((group) => group.includes(target))) groups.push([target]);
  const index = groups.findIndex((group) => group.includes(target));
  groups.splice(index + (placement === 'after' ? 1 : 0), 0, [source]);
  return Object.fromEntries(groups.flatMap((group, index) => group.map((id) => [id, index + 1])));
}
