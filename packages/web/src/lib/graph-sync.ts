import { batch } from '@preact/signals';
import { readGraphRecords, buildSimilarityGraphEdges, type LabbyDB } from '@labby/core';
import { keywordsSignal, keywordVectorsSignal, graphEdgesSignal } from '@/store';
export async function syncGraph(db: LabbyDB): Promise<void> {
  const records = await readGraphRecords(db.graph);
  batch(() => {
    keywordsSignal.value = records.flatMap(record => record.keyword ? [record.keyword] : []);
    keywordVectorsSignal.value = records.flatMap(record => record.vector ? [record.vector] : []);
    graphEdgesSignal.value = buildSimilarityGraphEdges(keywordVectorsSignal.value);
  });
}
