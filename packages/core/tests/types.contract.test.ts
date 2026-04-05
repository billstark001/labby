import { describe, expect, test } from 'vitest';
import type {
  DatabaseDump,
  EmailTask,
  LabbyDB,
  MetricExplanation,
  ScheduleMetrics,
  TemplateRenderResult,
} from '../src/index.js';

describe('core type contracts', () => {
  test('email task shape is consumable', () => {
    const task: EmailTask = {
      id: 'task-1',
      configId: 'cfg-1',
      daysOfWeek: [1, 3, 5],
      emails: ['a@example.com', 'b@example.com'],
      recentTimes: 0,
      templateText: 'Hello {{ name }}',
      sentCounts: { 'a@example.com': 1 },
    };

    expect(task.daysOfWeek.length).toBe(3);
    expect(task.recentTimes).toBe(0);
  });

  test('metrics and explanations are aligned', () => {
    const metrics: ScheduleMetrics = {
      uniformityPenalty: 1,
      questionerPenalty: 2,
      relevancePenalty: 3,
      presenterLoadPenalty: 4,
      questionerLoadPenalty: 5,
      totalRolePenalty: 6,
      invalidAssignmentPenalty: 7,
      constraintPenalty: 8,
      totalCost: 36,
    };

    const explanation: MetricExplanation = {
      key: 'totalCost',
      label: 'total',
      value: metrics.totalCost,
      summary: 'combined objective value',
    };

    expect(explanation.value).toBe(36);
  });

  test('template result supports errors', () => {
    const result: TemplateRenderResult = {
      output: 'hello',
      errors: [],
    };

    expect(result.output).toBe('hello');
    expect(result.errors).toHaveLength(0);
  });

  test('database dump includes email tasks', () => {
    const dump: DatabaseDump = {
      persons: [],
      keywords: [],
      keywordVectors: [],
      configs: [],
      constraints: [],
      schedules: [],
      unavailabilities: [],
      emailTasks: [],
    };

    expect(dump.emailTasks).toEqual([]);
  });

  test('labby db includes emailTasks store', () => {
    const dbShape = {
      persons: {} as LabbyDB['persons'],
      keywords: {} as LabbyDB['keywords'],
      keywordVectors: {} as LabbyDB['keywordVectors'],
      configs: {} as LabbyDB['configs'],
      constraints: {} as LabbyDB['constraints'],
      schedules: {} as LabbyDB['schedules'],
      unavailabilities: {} as LabbyDB['unavailabilities'],
      emailTasks: {} as LabbyDB['emailTasks'],
    };

    expect(dbShape).toBeTruthy();
  });
});
