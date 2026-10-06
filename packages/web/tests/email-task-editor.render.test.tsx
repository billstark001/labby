import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EmailTask, ScheduleConfig } from '@labby/core';
import { useEmailTaskEditor, type EmailTaskEditorProps } from '../src/pages/email-task/useEmailTaskEditor';
import { navigate, useRoute, useSyncRoute } from '../src/lib/router';
import { i18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn(), confirm: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/db', () => ({ useDatabase: () => ({ emailTasks: { get: mocks.get, put: mocks.put, delete: mocks.delete } }) }));
vi.mock('@/components/ui/Dialog', async importOriginal => ({ ...await importOriginal<object>(), confirmDialog: mocks.confirm }));
vi.mock('@/components/ui', async importOriginal => ({ ...await importOriginal<object>(), toast: { success: mocks.success, error: mocks.error } }));

const config: ScheduleConfig = { id: 'cfg', daysOfWeek: [1], timeRange: ['09:00', '10:00'], timezone: 'Asia/Tokyo',
  startDate: '2026-01-01', endDate: '2099-12-31', presentersPerSession: 1, questionersPerPresenter: 0,
  targetSimilarityRadius: 0.5, metadata: {} };
const task: EmailTask = { id: 'task', configId: 'cfg', daysOfWeek: [1], emails: ['test@example.com'], recentTimes: 0,
  templateText: '{{ nextSession.notes }}', sentCounts: { 'test@example.com': 3 }, skipNextRun: true,
  metadata: { customSetting: 'retain' } };
let props: EmailTaskEditorProps;
let editor: ReturnType<typeof useEmailTaskEditor>;
const container = document.createElement('div');
document.body.append(container);

function Harness() {
  editor = useEmailTaskEditor(props);
  return <span>{editor.isDirty ? 'dirty' : 'clean'}</span>;
}
function RouteHost() {
  useSyncRoute();
  const path = useRoute();
  return path.startsWith('/email-tasks/edit') ? <Harness /> : <span>{path}</span>;
}
async function mount() { await act(() => render(<RouteHost />, container)); }

beforeEach(() => {
  vi.clearAllMocks();
  i18n.lang.value = 'en';
  window.history.replaceState(null, '', '#/email-tasks/edit/task');
  mocks.get.mockResolvedValue(structuredClone(task));
  mocks.put.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  props = { taskId: 'task', task, configs: [config], persons: [], schedules: [], systemTimezone: 'UTC' };
});
afterEach(async () => { await act(() => render(null, container)); });

test('save retains edits made while pending and the existing delivery state', async () => {
  await mount();
  await act(() => editor.form.setFieldValue('notes', 'saved note'));
  let finish!: () => void;
  mocks.put.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let saving!: Promise<void>;
  await act(async () => { saving = editor.saveTask(); });
  await act(() => editor.form.setFieldValue('notes', 'newer note'));
  await act(async () => { finish(); await saving; });
  expect(mocks.put.mock.calls[0][0].notes).toBe('saved note');
  expect(mocks.put.mock.calls[0][0].sentCounts).toEqual(task.sentCounts);
  expect(mocks.put.mock.calls[0][0].skipNextRun).toBe(true);
  expect(mocks.put.mock.calls[0][0].metadata.customSetting).toBe('retain');
  expect(editor.values.notes).toBe('newer note');
  expect(editor.isDirty).toBe(true);
  expect(editor.currentTask?.notes).toBe('saved note');
  mocks.put.mockResolvedValue(undefined);
  await act(async () => { await editor.saveTask(); });
  expect(editor.isDirty).toBe(false);
  expect(mocks.put.mock.calls[1][0].notes).toBe('newer note');
});

test('failed saves retain the draft and can be retried', async () => {
  await mount();
  await act(() => editor.form.setFieldValue('templateText', 'updated'));
  mocks.put.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { expect(await editor.action.run('save', editor.saveTask)).toBe(false); });
  expect(editor.values.templateText).toBe('updated');
  expect(editor.isDirty).toBe(true);
  expect(editor.action.error).toContain('offline');
  await act(async () => { expect(await editor.action.run('save', editor.saveTask)).toBe(true); });
  expect(editor.isDirty).toBe(false);
});

test('navigation is blocked before unmount, and confirmation proceeds once', async () => {
  await mount();
  await act(() => editor.form.setFieldValue('notes', 'draft'));
  await act(() => navigate('/email-tasks'));
  expect(window.location.hash).toBe('#/email-tasks/edit/task');
  expect(container.textContent).toBe('dirty');
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  await act(async () => { mocks.confirm.mock.calls[0][2](); });
  expect(container.textContent).toBe('/email-tasks');
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
});

test('direct hash navigation and unload keep unsaved edits protected; reverting is clean', async () => {
  await mount();
  await act(() => editor.form.setFieldValue('notes', 'draft'));
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => {
    window.location.hash = '#/persons';
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(window.location.hash).toBe('#/email-tasks/edit/task');
  expect(container.textContent).toBe('dirty');
  expect(editor.values.notes).toBe('draft');
  await act(() => editor.form.setFieldValue('notes', ''));
  expect(editor.isDirty).toBe(false);
});

test('a new task saved while editing continues uses the same ID on the next save', async () => {
  props = { ...props, taskId: undefined, task: undefined };
  window.history.replaceState(null, '', '#/email-tasks/edit');
  await mount();
  let finish!: () => void;
  mocks.put.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  let saving!: Promise<void>;
  await act(async () => { saving = editor.saveTask(); });
  await act(() => editor.form.setFieldValue('notes', 'continue editing'));
  await act(async () => { finish(); await saving; });
  const id = editor.selectedTaskId;
  expect(editor.isDirty).toBe(true);
  expect(window.location.hash).toBe('#/email-tasks/edit');
  mocks.get.mockResolvedValue(editor.currentTask);
  await act(async () => { await editor.saveTask(); });
  expect(mocks.put.mock.calls[1][0].id).toBe(id);
  expect(window.location.hash).toBe(`#/email-tasks/edit/${id}`);
});

test('a new task keeps one ID across an uncertain save failure and retry', async () => {
  props = { ...props, taskId: undefined, task: undefined };
  window.history.replaceState(null, '', '#/email-tasks/edit');
  await mount();
  await act(() => editor.form.setFieldValue('notes', 'draft'));
  mocks.put.mockRejectedValueOnce(new Error('response lost'));
  await act(async () => { await editor.action.run('save', editor.saveTask); });
  const firstId = mocks.put.mock.calls[0][0].id;
  expect(editor.isDirty).toBe(true);
  await act(async () => { await editor.action.run('save', editor.saveTask); });
  expect(mocks.put.mock.calls[1][0].id).toBe(firstId);
});
