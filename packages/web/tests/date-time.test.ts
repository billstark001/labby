import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLocalDateTime24 } from '../src/lib/date-time.js';

test('local date-time display uses 00–23 hours in every UI language', () => {
  for (const locale of ['en-US', 'zh-CN', 'ja-JP']) {
    assert.match(formatLocalDateTime24(Date.UTC(2026, 0, 1, 0), locale, 'UTC'), /00:00:00/);
    assert.match(formatLocalDateTime24(Date.UTC(2026, 0, 1, 13, 5), locale, 'UTC'), /13:05:00/);
  }
});
