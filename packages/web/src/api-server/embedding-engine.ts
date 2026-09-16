import { apiClient } from '@/lib/api';
import type { RankingJudgment, RankingQuery, TrainingResult } from '@labby/core';

export async function recommendRanking(excludedKeys: readonly string[]): Promise<RankingQuery | null> {
  const response = await apiClient.request<{ query: RankingQuery | null }>('/nlp/recommend-ranking', {
    method: 'POST', body: JSON.stringify({ excludedKeys, size: 5 }),
  });
  return response.query;
}

export function trainRanking(judgment: RankingJudgment): Promise<TrainingResult> {
  return apiClient.request<TrainingResult>('/nlp/train-ranking', { method: 'POST', body: JSON.stringify(judgment) });
}
