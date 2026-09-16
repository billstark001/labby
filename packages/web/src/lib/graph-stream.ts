import { productDistance, validateGraphRecord } from '@labby/core';
import type { GraphRecord, GraphStore, GraphSnapshotEdge, KeywordVector } from '@labby/core';

type Neighbor = { id: string; distance: number };
const compareNeighbors = (a: Neighbor, b: Neighbor) =>
  a.distance - b.distance || a.id.localeCompare(b.id);

/** Maintain nearest-neighbor lists only for sources affected by changed coordinates. */
export class GraphModel {
  version = 0;
  records = new Map<string, GraphRecord>();
  private neighbors = new Map<string, Neighbor[]>();

  clear(): void {
    this.records.clear();
    this.neighbors.clear();
    this.version++;
  }

  apply(items: readonly GraphRecord[]): void {
    items.forEach(validateGraphRecord);
    const records = new Map(this.records);
    const neighbors = new Map(this.neighbors);
    const changed = new Set<string>();
    let updated = false;
    for (const item of items) {
      if (JSON.stringify(records.get(item.id)) === JSON.stringify(item) ||
          (!item.keyword && !records.has(item.id))) continue;
      updated = true;
      const previous = records.get(item.id)?.vector;
      const next = item.keyword ? item.vector : null;
      if (JSON.stringify(previous) !== JSON.stringify(next)) changed.add(item.id);
      if (item.keyword) records.set(item.id, item);
      else records.delete(item.id);
      if (!next) neighbors.delete(item.id);
    }
    if (!updated) return;
    const vectors = [...records.values()].flatMap((record) =>
      record.vector ? [record.vector] : [],
    );
    const changedVectors = vectors.filter((vector) => changed.has(vector.keywordId));
    for (const source of vectors) {
      const known = neighbors.get(source.keywordId);
      let affected =
        changed.has(source.keywordId) ||
        !known ||
        known.some((neighbor) => changed.has(neighbor.id));
      if (!affected && known) {
        const boundary = known.at(-1);
        affected = changedVectors.some((target) => {
          if (target.keywordId === source.keywordId) return false;
          const candidate = { id: target.keywordId, distance: productDistance(source, target) };
          return (
            known.length < Math.min(4, vectors.length - 1) ||
            !boundary ||
            compareNeighbors(candidate, boundary) < 0
          );
        });
      }
      if (affected) {
        neighbors.set(
          source.keywordId,
          vectors
            .filter((target) => target.keywordId !== source.keywordId)
            .map((target) => ({ id: target.keywordId, distance: productDistance(source, target) }))
            .sort(compareNeighbors)
            .slice(0, 4),
        );
      }
    }
    // Commit records and neighbor lists together; failures leave the last valid frame intact.
    this.records = records;
    this.neighbors = neighbors;
    this.version++;
  }

  get edges(): GraphSnapshotEdge[] {
    const edges = new Map<string, GraphSnapshotEdge>();
    for (const [source, neighbors] of this.neighbors) {
      for (const neighbor of neighbors) {
        const [sourceId, targetId] = [source, neighbor.id].sort() as [string, string];
        edges.set(JSON.stringify([sourceId, targetId]), {
          sourceId,
          targetId,
          weight: 1 / (1 + neighbor.distance),
        });
      }
    }
    return [...edges.values()];
  }

  get vectors(): KeywordVector[] {
    return [...this.records.values()].flatMap((record) => (record.vector ? [record.vector] : []));
  }
}

export interface GraphStreamStatus {
  loading: boolean;
  syncing: boolean;
  count: number;
  error: string | null;
}

/** Checkpoints are committed only after an entire batch; failed batches can be replayed safely. */
export class GraphStream {
  readonly model = new GraphModel();
  private checkpoint: string | undefined;
  private pending: Promise<void> | undefined;
  private rerun = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  constructor(
    private readonly store: GraphStore,
    private readonly publish: (model: GraphModel, status: GraphStreamStatus) => void,
    private readonly yieldPage: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 0)),
  ) {}

  start(): () => void {
    this.stopped = false;
    const lifecycle = this.generation;
    const poll = async () => {
      try { await this.refresh(); } catch { /* UI exposes failure. */ }
      if (!this.stopped && lifecycle === this.generation) this.timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      this.stopped = true;
      this.generation++;
      if (this.timer) clearTimeout(this.timer);
    };
  }

  refresh(): Promise<void> {
    if (this.pending) {
      this.rerun = true;
      return this.pending;
    }
    this.pending = (async () => {
      do {
        this.rerun = false;
        await this.drain();
      } while (this.rerun);
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async drain(): Promise<void> {
    const generation = this.generation;
    const initial = !this.checkpoint;
    if (initial) this.model.clear();
    let catchUp = initial;
    let cursor: string | undefined;
    let resets = 0;
    this.publish(this.model, {
      loading: initial,
      syncing: true,
      count: this.model.records.size,
      error: null,
    });
    try {
      do {
        const page = await this.store.list(
          cursor ? { cursor, limit: 100 } : { since: this.checkpoint, limit: 100 },
        );
        if (generation !== this.generation) return;
        if (page.reset) {
          if (++resets > 2) throw new Error('Graph database changed repeatedly. Retry.');
          this.model.clear();
          this.checkpoint = undefined;
          cursor = undefined;
          catchUp = true;
          continue;
        }
        this.model.apply(page.items);
        cursor = page.nextCursor ?? undefined;
        this.publish(this.model, {
          loading: initial,
          syncing: true,
          count: this.model.records.size,
          error: null,
        });
        await this.yieldPage();
        if (generation !== this.generation) return;
        if (!cursor) {
          if (!page.checkpoint) throw new Error('Graph page is missing its checkpoint');
          this.checkpoint = page.checkpoint;
          // Changes committed while the initial keyset scan was running must be replayed.
          if (catchUp) {
            catchUp = false;
            continue;
          }
          break;
        }
      } while (true);
      this.publish(this.model, {
        loading: false,
        syncing: false,
        count: this.model.records.size,
        error: null,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish(this.model, {
        loading: false,
        syncing: false,
        count: this.model.records.size,
        error: String(error),
      });
      throw error;
    }
  }
}
