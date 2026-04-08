import { apiClient } from "@/lib/api";
import { KeywordVector, IterativeUpdateOptions, SupervisionQuery, TripletQuery } from "@labby/core";

export async function applyPairUpdate(
  leftId: string,
  rightId: string,
  targetDistance: number,
  options: IterativeUpdateOptions,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/update-pair', {
    method: 'POST',
    body: JSON.stringify({
      leftId,
      rightId,
      targetDistance,
      updateOptions: options,
    }),
  });
}

export async function applySupervision(
  query: SupervisionQuery,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/apply-supervision', {
    method: 'POST',
    body: JSON.stringify(query),
  });
}


export async function recommendTriplet(
  recentPairKeys: readonly string[],
): Promise<TripletQuery | null> {
  const response = await apiClient.request<{ query: TripletQuery | null }>('/nlp/recommend-triplet', {
    method: 'POST',
    body: JSON.stringify({
      excludedPairs: [...recentPairKeys],
    }),
  });
  return response.query;
}


export async function applyTriplet(
  query: TripletQuery,
  margin = 0.2,
  options?: IterativeUpdateOptions,
): Promise<{ loss: number; updatedVectors: KeywordVector[] }> {
  return apiClient.request<{ loss: number; updatedVectors: KeywordVector[] }>('/nlp/update-similarity', {
    method: 'POST',
    body: JSON.stringify({
      anchorId: query.anchorId,
      positiveId: query.positiveId,
      negativeId: query.negativeId,
      margin,
      updateOptions: options,
    }),
  });
}