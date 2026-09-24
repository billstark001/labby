import { describe, expect, test } from 'vitest';
import { buildEmailTemplateScheduleVariables, parseTemplate, renderTemplate } from '../src/template/index.js';

describe('template parser', () => {
  test('parses plain text', () => {
    const parsed = parseTemplate('hello world');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.segments).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  test('parses expression with double braces', () => {
    const parsed = parseTemplate('Hi {{ user.name }}!');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: 'user.name',
      delimiterLength: 2,
    });
  });

  test('supports longer matching delimiters', () => {
    const parsed = parseTemplate('Value: {{{{ a + 1 }}}}');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: 'a + 1',
      delimiterLength: 4,
    });
  });

  test('keeps object literal braces inside expression', () => {
    const parsed = parseTemplate('X {{ ({ a: 1 }).a }} Y');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.segments[1]).toMatchObject({
      type: 'expression',
      expr: '({ a: 1 }).a',
    });
  });

  test('reports unclosed expression', () => {
    const parsed = parseTemplate('Hi {{ user.name');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.kind).toBe('template');
  });
});

describe('template renderer', () => {
  test('renders markdown template', () => {
    const rendered = renderTemplate('Hi {{ name }}', { name: 'Labby' });
    expect(rendered.errors).toHaveLength(0);
    expect(rendered.output).toBe('Hi Labby');
  });

  test('renders html-safe values when format=html', () => {
    const rendered = renderTemplate('<p>{{ html }}</p>', { html: '<b>X</b>' }, { format: 'html' });
    expect(rendered.errors).toHaveLength(0);
    expect(rendered.output).toBe('<p>&lt;b&gt;X&lt;/b&gt;</p>');
  });

  test('collects eval errors in non-strict mode', () => {
    const rendered = renderTemplate('A {{ unknown }} B', {});
    expect(rendered.errors).toHaveLength(1);
    expect(rendered.output).toBe('A  B');
    expect(rendered.errors[0]?.kind).toBe('eval');
  });

  test('allows functions provided by template context', () => {
    const rendered = renderTemplate('Next: {{ nextSessionDateText() }}', {
      nextSessionDateText: () => '2026-06-08',
    });
    expect(rendered.errors).toHaveLength(0);
    expect(rendered.output).toBe('Next: 2026-06-08');
  });

  test('stops in strict mode on first error', () => {
    const rendered = renderTemplate('A {{ unknown }} B {{ 1 + 1 }}', {}, { strict: true });
    expect(rendered.errors).toHaveLength(1);
    expect(rendered.output).toBe('A ');
  });
});

test('next-session time uses 24-hour clock in all template languages', () => {
  for (const locale of ['en', 'zh-CN', 'ja-JP']) {
    const variables = buildEmailTemplateScheduleVariables({
      plan: {
        id: 'plan', configId: 'config', createdAt: Date.UTC(2026, 0, 1),
        sessions: [{ date: '2026-01-02', presentations: [] }],
      },
      config: {
        id: 'config', daysOfWeek: [5], timeRange: ['00:30', '13:05'],
        presentersPerSession: 1, questionersPerPresenter: 1,
        targetSimilarityRadius: 0.5, startDate: '2026-01-01', endDate: '2026-01-31', metadata: {},
      },
      locale,
      anchorDate: '2026-01-01',
    });
    expect(variables.scheduleNextSessionTimeText).toBe('00:30 - 13:05');
  }
});
