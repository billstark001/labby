import { batch, computed, signal } from '@preact/signals';
import type { LabbyDB, Keyword, KeywordVector, GraphSnapshotEdge } from '@labby/core';
import { keywordsSignal, keywordVectorsSignal, graphEdgesSignal } from '@/store';
import { GraphStream, type GraphStreamStatus } from './graph-stream';

// Graph pages must not be overwritten by the first-page caches used on other routes.
export const graphData = signal<{
  keywords: Keyword[];
  vectors: KeywordVector[];
  edges: GraphSnapshotEdge[];
}>({ keywords: [], vectors: [], edges: [] });
let publishedStream: GraphStream | undefined;
let graphGeneration = 0;

export const graphStreamStatus = signal<GraphStreamStatus>({
  loading: true,
  syncing: false,
  count: 0,
  error: null,
});
let streams = new WeakMap<LabbyDB, GraphStream>();
export function resetGraphStreamState(): void {
  graphGeneration++;
  streams = new WeakMap<LabbyDB, GraphStream>();
  publishedStream = undefined;
  graphData.value = { keywords: [], vectors: [], edges: [] };
  graphStreamStatus.value = { loading: true, syncing: false, count: 0, error: null };
}
export const graphReady = computed(() => !graphStreamStatus.value.loading);
export function graphStream(db: LabbyDB): GraphStream {
  let stream = streams.get(db);
  if (!stream) {
    const generation = graphGeneration;
    let publishedVersion = -1;
    stream = new GraphStream(
      db.graph,
      (model, status) => {
        if (generation !== graphGeneration) return;
        batch(() => {
          if (publishedVersion !== model.version || publishedStream !== stream) {
            publishedVersion = model.version;
            publishedStream = stream;
            keywordsSignal.value = [...model.records.values()].flatMap((record) =>
              record.keyword ? [record.keyword] : [],
            );
            keywordVectorsSignal.value = model.vectors;
            graphEdgesSignal.value = model.edges;
            graphData.value = {
              keywords: keywordsSignal.peek(),
              vectors: keywordVectorsSignal.peek(),
              edges: graphEdgesSignal.peek(),
            };
          }
          const previous = graphStreamStatus.peek();
          if (
            previous.loading !== status.loading ||
            previous.syncing !== status.syncing ||
            previous.count !== status.count ||
            previous.error !== status.error
          )
            graphStreamStatus.value = status;
        });
      },
      () => new Promise((resolve) => setTimeout(resolve, 16)),
    );
    streams.set(db, stream);
  }
  return stream;
}
export const syncGraph = (db: LabbyDB) => graphStream(db).refresh();
