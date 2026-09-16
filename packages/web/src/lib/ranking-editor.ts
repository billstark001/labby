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
