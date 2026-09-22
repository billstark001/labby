import type { GraphPage, GraphQuery, GraphRecord, GraphStore } from './db.js';
import { validateKeywordVector } from './embedding/geometry.js';

/** Reject corrupt transport/storage records before they can reach reactive UI state. */
export function validateGraphRecord(record: GraphRecord): void {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(record) || typeof record.id !== 'string' || !record.id ||
      (record.keyword !== null && (!object(record.keyword) || record.keyword.id !== record.id)) ||
      (record.vector !== null && (!object(record.vector) || !record.keyword || record.vector.keywordId !== record.id))) {
    throw new Error('Malformed graph record: expected objects with matching IDs');
  }
  if (record.keyword) {
    const { name, names } = record.keyword;
    if ((name !== undefined && typeof name !== 'string') ||
        (names !== undefined && (!object(names) || Object.values(names).some(value => typeof value !== 'string')))) {
      throw new Error('Malformed graph keyword names');
    }
  }
  if (record.vector) validateKeywordVector(record.vector);
}

export interface GraphClock {
  epoch: string;
  revision: string;
}
export interface GraphPagePlan extends GraphClock {
  mode: 'snapshot' | 'changes';
  after: string;
  limit: number;
}
export interface GraphRow extends GraphRecord {
  revision?: string;
}

const revisionPattern = /^(0|[1-9][0-9]{0,19})$/;
function parseToken(token: string): Record<string, unknown> {
  try {
    if (token.length > 4096) throw new Error();
    const parsed = JSON.parse(token);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.epoch !== 'string' ||
      typeof parsed.revision !== 'string' ||
      !revisionPattern.test(parsed.revision) ||
      BigInt(parsed.revision) > 9223372036854775807n
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error('Invalid graph cursor or checkpoint');
  }
}

/** Capture a high-water mark for each delta batch; later changes belong to the next batch. */
export function planGraphPage(query: GraphQuery, clock: GraphClock): GraphPagePlan | null {
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 250 || (query.cursor && query.since)) {
    throw new Error('Invalid graph page query');
  }
  if (query.cursor) {
    const token = parseToken(query.cursor);
    if (token.epoch !== clock.epoch || BigInt(String(token.revision)) > BigInt(clock.revision))
      return null;
    if (
      !['snapshot', 'changes'].includes(String(token.mode)) ||
      typeof token.after !== 'string' ||
      (token.mode === 'changes' &&
        (!revisionPattern.test(token.after) ||
          BigInt(token.after) > BigInt(String(token.revision))))
    ) {
      throw new Error('Invalid graph cursor');
    }
    return {
      epoch: clock.epoch,
      revision: String(token.revision),
      after: token.after,
      mode: token.mode as GraphPagePlan['mode'],
      limit,
    };
  }
  if (query.since) {
    const token = parseToken(query.since);
    if (token.epoch !== clock.epoch || BigInt(String(token.revision)) > BigInt(clock.revision))
      return null;
    return { ...clock, mode: 'changes', after: String(token.revision), limit };
  }
  return { ...clock, mode: 'snapshot', after: '', limit };
}

export function finishGraphPage(plan: GraphPagePlan | null, rows: GraphRow[]): GraphPage {
  if (!plan) return { items: [], nextCursor: null, checkpoint: null, reset: true };
  const selected = rows.slice(0, plan.limit);
  selected.forEach(validateGraphRecord);
  const more = rows.length > plan.limit;
  const last = selected.at(-1);
  return {
    items: selected.map(({ id, keyword, vector }) => ({ id, keyword, vector })),
    nextCursor: more
      ? JSON.stringify({
          epoch: plan.epoch,
          revision: plan.revision,
          mode: plan.mode,
          after: plan.mode === 'snapshot'
            ? `${last!.keyword?.disabled ? '1' : '0'}:${last!.id}`
            : last!.revision,
        })
      : null,
    checkpoint: more ? null : JSON.stringify({ epoch: plan.epoch, revision: plan.revision }),
    reset: false,
  };
}

/** Algorithms may need the complete point set; UI consumes pages as they arrive instead. */
export async function readGraphRecords(store: GraphStore): Promise<GraphRecord[]> {
  const records = new Map<string, GraphRecord>();
  let cursor: string | undefined;
  let since: string | undefined;
  let snapshot = true;
  do {
    const page = await store.list(cursor ? { cursor } : { since });
    if (page.reset) throw new Error('Graph changed database identity while loading; retry');
    for (const item of page.items) {
      if (item.keyword) records.set(item.id, item);
      else records.delete(item.id);
    }
    cursor = page.nextCursor ?? undefined;
    if (!cursor) {
      if (snapshot) {
        snapshot = false;
        since = page.checkpoint!;
        continue;
      }
      break;
    }
  } while (true);
  return [...records.values()];
}
