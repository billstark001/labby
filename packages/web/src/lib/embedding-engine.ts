import { syncGraph } from './graph-sync';
import { readGraphRecords, initKeywordVectors, ProductEmbeddingEngine } from '@labby/core';
import type { LabbyDB, RankingJudgment, RankingQuery, TrainingResult } from '@labby/core';
import * as api from '@/api-server/embedding-engine';
import { isServerDeployment } from '@/lib/runtime';

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work); queue = next.catch(() => {}); return next;
}
async function load(db: LabbyDB, persistMissing: boolean, includeDisabled = false): Promise<{ engine: ProductEmbeddingEngine; missingIds: Set<string>; history: RankingJudgment[] }> {
  const records = await readGraphRecords(db.graph);
  const keywords = records.flatMap(record => record.keyword ? [record.keyword] : []);
  const vectors = records.flatMap(record => record.vector ? [record.vector] : []);
  const ids = new Set(vectors.map(v => v.keywordId));
  const missing = initKeywordVectors(keywords.filter(k => !ids.has(k.id)).map(k => k.id), vectors[0]?.geometry);
  if (persistMissing && missing.length) await db.keywordVectors.putMany(missing);
  const includedIds = new Set(keywords.filter(keyword => includeDisabled || !keyword.disabled).map(keyword => keyword.id));
  const history = await db.similarity.getHistory();
  return { engine: new ProductEmbeddingEngine([...vectors, ...missing].filter(vector => includedIds.has(vector.keywordId)), history), missingIds: new Set(missing.filter(vector => includedIds.has(vector.keywordId)).map(v => v.keywordId)), history };
}

export function recommendRanking(db: LabbyDB, excludedKeys: readonly string[], includeDisabled = false): Promise<RankingQuery | null> {
  return serial(async () => {
    const work = async () => isServerDeployment ? api.recommendRanking(excludedKeys, includeDisabled) : (await load(db, true, includeDisabled)).engine.recommendRanking({ excludedKeys: [...excludedKeys], size: 5 });
    if (!isServerDeployment && typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('labby-similarity', work);
    return work();
  });
}
export function trainRanking(db: LabbyDB, judgment: RankingJudgment): Promise<TrainingResult> {
  return serial(async () => {
    const work = async () => {
      const prepared = isServerDeployment ? undefined : await load(db, false);
      const activeIds = prepared ? new Set(prepared.engine.getVectors().map(vector => vector.keywordId)) : undefined;
      const groups = activeIds ? judgment.groups.map(group => group.filter(id => activeIds.has(id))).filter(group => group.length) : judgment.groups;
      const result = prepared && (!activeIds!.has(judgment.anchorId) || groups.flat().length < 2)
        ? { accepted: true, loss: 0, updatedVectors: [], history: prepared.history, conflicts: [], maxDistanceDrift: 0 }
        : prepared ? prepared.engine.trainRanking({ ...judgment, groups }) : await api.trainRanking(judgment);
      if (result.accepted && prepared) {
        const activeHistoryIds = new Set(result.history.map(item => item.id));
        result.history.push(...prepared.history.filter(item => !activeHistoryIds.has(item.id)));
        const changed = new Set(result.updatedVectors.map(v => v.keywordId));
        result.updatedVectors.push(...prepared.engine.getVectors().filter(v => prepared.missingIds.has(v.keywordId) && !changed.has(v.keywordId)));
      }
      if (result.accepted) {
        if (!isServerDeployment) await db.similarity.commit(result.updatedVectors, result.history);
        await syncGraph(db);
      }
      return result;
    };
    // Coordinate edits across browser tabs sharing the same local database.
    if (!isServerDeployment && typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('labby-similarity', work);
    return work();
  });
}
