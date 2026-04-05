import { describe, expect, test } from 'vitest';
import { DEFAULT_TEMPLATE_PRESETS, renderTemplate } from '../src/index.js';

describe('default template presets', () => {
  test('provides markdown/html presets', () => {
    expect(DEFAULT_TEMPLATE_PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_TEMPLATE_PRESETS.some((preset) => preset.format === 'markdown')).toBe(true);
    expect(DEFAULT_TEMPLATE_PRESETS.some((preset) => preset.format === 'html')).toBe(true);
  });

  test('all presets can be rendered with baseline context', () => {
    const context = {
      recipient: 'x@example.com',
      configId: 'cfg',
      now: '2026-01-01T00:00:00.000Z',
      sessionCount: 3,
      summary: 'ok',
    };

    for (const preset of DEFAULT_TEMPLATE_PRESETS) {
      const result = renderTemplate(preset.content, context, { format: preset.format });
      expect(result.errors).toHaveLength(0);
      expect(result.output.length).toBeGreaterThan(0);
    }
  });
});
