import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import { InsertSessionDialog } from '../src/pages/schedule/dialogs';
import { ScheduleView } from '../src/pages/schedule/ScheduleView';
import { createScheduleDraft } from '../src/pages/schedule/schedule-editor';
import { i18n } from '../src/i18n';

const container = document.createElement('div');
document.body.append(container);
afterEach(async () => { await act(() => render(null, container)); });

test('meeting details dialog edits note and optional time alongside the date', async () => {
  const details = {
    notes: 'Room B', startTime: '14:00', endTime: '16:00', overrideTime: true,
    onNotesChange: vi.fn(), onStartTimeChange: vi.fn(), onEndTimeChange: vi.fn(), onOverrideTimeChange: vi.fn(),
  };
  await act(() => render(<InsertSessionDialog open title={i18n.t('editSessionDetails')} insertedSessionDate="2026-10-06"
    onInsertedDateChange={() => {}} onApply={() => {}} onClose={() => {}} details={details} />, container));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('input[type="date"]')).not.toBeNull();
  const note = dialog.querySelector('textarea')!;
  expect(note.value).toBe('Room B');
  const times = dialog.querySelectorAll<HTMLInputElement>('input[type="time"]');
  expect([...times].map(input => input.value)).toEqual(['14:00', '16:00']);
  await act(() => { note.value = 'Bring slides'; note.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(details.onNotesChange).toHaveBeenCalledWith('Bring slides');
  await act(() => { times[0]!.value = '15:00'; times[0]!.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(details.onStartTimeChange).toHaveBeenCalledWith('15:00');
  await act(() => { (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  expect(details.onOverrideTimeChange).toHaveBeenCalledWith(false);
});

test('meeting details are shown beside the actions and the combined edit action is edit-only', async () => {
  const draft = createScheduleDraft({ id: 'plan', configId: 'config', createdAt: 1, sessions: [{
    date: '2026-10-06', notes: 'Room B', timeRange: ['15:00', '17:00'], presentations: [],
  }] });
  const noop = () => {};
  const onRescheduleSession = vi.fn();
  const props = {
    draft, personMap: new Map(), similarities: { getPairSimilarity: () => 0.5 },
    highlightPersonIds: new Set<string>(), highlightOnly: false,
    onHighlightPerson: noop, onInsertPresentation: noop, onDeletePresentation: noop,
    onReplacePresenter: noop, onAddQuestioner: noop, onReplaceQuestioner: noop,
    onDeleteQuestioner: noop, onMoveQuestioner: noop, onReorderPresentations: noop,
    onMovePresentationTo: noop, onMoveBoundary: noop, onMoveBoundaryTo: noop,
    onShiftSuffix: noop, onInsertSession: noop, onRescheduleSession, onPostponeSession: noop,
    onSwapSession: noop, onDeleteSession: noop, onShowMetricsForSession: noop,
  };
  await act(() => render(<ScheduleView {...props} manualEditMode={false} />, container));
  const summary = container.querySelector('[title="15:00–17:00 · Room B"]')!;
  expect(summary.textContent).toBe('15:00–17:00 · Room B');
  await act(() => { (container.querySelector('button') as HTMLButtonElement).click(); });
  expect(document.body.textContent).not.toContain(i18n.t('editSessionDetails'));
  await act(() => render(null, container));
  await act(() => render(<ScheduleView {...props} manualEditMode />, container));
  expect(container.querySelector('[title="15:00–17:00 · Room B"]')).toBeNull();
  await act(() => { container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('scheduleActions')}"]`)!.click(); });
  const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === i18n.t('editSessionDetails'))!;
  expect(edit).toBeDefined();
  await act(() => edit.click());
  expect(onRescheduleSession).toHaveBeenCalledWith(draft.sessions[0]!.id);
});
