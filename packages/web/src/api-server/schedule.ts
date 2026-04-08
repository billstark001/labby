import { apiClient } from "@/lib/api";
import { MetricExplanation, ScheduleConfig, ScheduleMetrics, SchedulePlan } from "@labby/core";

interface MetricsResult {
  metrics: ScheduleMetrics;
  explanations: MetricExplanation[];
}

export async function runFull(config: ScheduleConfig, personIds: string[]): Promise<unknown> {
  return apiClient.request<unknown>('/solver/run', {
    method: 'POST',
    body: JSON.stringify({ configId: config.id, personIds }),
  });
}

export async function runIncremental(
  config: ScheduleConfig,
  currentPlan: SchedulePlan,
  changeDate: string,
  personIds: string[],
): Promise<unknown> {
  return apiClient.request<unknown>('/solver/run-incremental', {
    method: 'POST',
    body: JSON.stringify({
      configId: config.id,
      previousPlanId: currentPlan.id,
      changeDate,
      personIds,
    }),
  });
}

export async function computeMetricsForPlan(
  plan: SchedulePlan,
): Promise<MetricsResult> {
  return apiClient.request<MetricsResult>('/solver/metrics', {
    method: 'POST',
    body: JSON.stringify({ scheduleId: plan.id }),
  });
}

export async function computeMetricsForSession(
  plan: SchedulePlan,
  sessionDate: string,
): Promise<MetricsResult> {
  return apiClient.request<MetricsResult>('/solver/metrics', {
    method: 'POST',
    body: JSON.stringify({ scheduleId: plan.id, sessionDate }),
  });
}