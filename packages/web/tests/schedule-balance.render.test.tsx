import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import type { ScheduleConfig } from '@labby/core';
import { ConfigForm } from '../src/pages/schedule/forms';
import { i18n } from '../src/i18n';

const mounted: HTMLDivElement[] = [];
afterEach(async () => {
  for (const container of mounted.splice(0)) {
    await act(() => render(null, container));
    container.remove();
  }
});

test('schedule configuration exposes and persists presenter and questioner gap policies', async () => {
  const initial: ScheduleConfig = {
    id: 'config', daysOfWeek: [1], timeRange: ['14:00', '16:00'],
    presentersPerSession: 2, questionersPerPresenter: 2, targetSimilarityRadius: 0.5,
    startDate: '2026-01-05', endDate: '2026-06-29',
    gapBalance: { presenter: { shortGapRatio: 0.65 } },
  };
  const onSave = vi.fn(async (_config: ScheduleConfig) => {});
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  await act(() => render(<ConfigForm initial={initial} onSave={onSave} onCancel={() => {}} />, container));
  const details = container.querySelector('details')!;
  expect(details.textContent).toContain(i18n.t('gapBalanceSettings'));
  const presenterRatio = details.querySelector('fieldset input[type="number"]') as HTMLInputElement;
  expect(presenterRatio.value).toBe('65');
  await act(() => { presenterRatio.value = '80'; presenterRatio.dispatchEvent(new Event('input', { bubbles: true })); });
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('save'))!;
  await act(async () => { save.click(); await Promise.resolve(); });
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave.mock.calls[0]![0].gapBalance).toMatchObject({ presenter: { shortGapRatio: 0.8 }, questioner: { shortGapRatio: 0.75, shortGapWeight: 16, spreadWeight: 2 } });
});
