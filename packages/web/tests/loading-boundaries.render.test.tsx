import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  taskGet: (_id: string): Promise<unknown> => Promise.resolve(undefined),
  taskPut: (_task: unknown): Promise<void> => Promise.resolve(),
  personsList: (_query: unknown): Promise<unknown> => Promise.resolve({ items: [], total: 0 }),
  personBundle: (_ids: string[]): Promise<unknown> => Promise.resolve({
    keywords: [], personTags: [], referencedPersonIds: [],
  }),
  settingsGet: (): Promise<unknown> => Promise.resolve({ timezone: 'UTC' }),
  keywords: [] as unknown[],
  configs: [] as unknown[],
  persons: [] as unknown[],
  schedules: [] as unknown[],
}));

vi.mock('@/db', () => {
  const emptyStore = { list: async () => ({ items: [], total: 0 }) };
  const db = {
    emailTasks: { get: (id: string) => source.taskGet(id), put: (task: unknown) => source.taskPut(task), ...emptyStore },
    configs: { list: async () => ({ items: source.configs, total: source.configs.length }) },
    persons: { list: async () => ({ items: source.persons, total: source.persons.length }) },
    schedules: { list: async () => ({ items: source.schedules, total: source.schedules.length }) },
    personTags: emptyStore,
    keywords: { list: async () => ({ items: source.keywords, total: source.keywords.length }) },
    systemSettings: { get: () => source.settingsGet() },
  };
  return {
    useDatabase: () => db,
    readAllPaginated: async (store: typeof emptyStore) => (await store.list()).items,
    listPersonsPage: (_db: unknown, query: unknown) => source.personsList(query),
    readPersonForeignKeys: (_db: unknown, ids: string[]) => source.personBundle(ids),
    buildPersonReferenceCount: () => new Map(),
  };
});

import { EmailTaskEditPage } from '../src/pages/email-task/EmailTaskEditPage';
import { PersonsTab } from '../src/pages/person/PersonsTab';
import { SettingsPage } from '../src/pages/SettingsPage';
import { i18n } from '../src/i18n';

const mounted: HTMLDivElement[] = [];
function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  return container;
}

afterEach(async () => {
  for (const container of mounted.splice(0)) {
    await act(() => render(null, container));
    container.remove();
  }
  source.taskGet = async () => undefined;
  source.taskPut = async () => {};
  source.personsList = async () => ({ items: [], total: 0 });
  source.personBundle = async () => ({ keywords: [], personTags: [], referencedPersonIds: [] });
  source.keywords = [];
  source.configs = [];
  source.persons = [];
  source.schedules = [];
  source.settingsGet = async () => ({ timezone: 'UTC' });
});

it('waits for the requested email task before deciding it is missing', async () => {
  let finish!: (task: unknown) => void;
  source.taskGet = () => new Promise(resolve => { finish = resolve; });
  const container = mount();

  await act(() => render(<EmailTaskEditPage taskId="missing" />, container));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.textContent).not.toContain(i18n.t('emailTaskNotFound'));
  expect(container.textContent).not.toContain(i18n.t('save'));

  await act(async () => {
    finish(undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain(i18n.t('emailTaskNotFound'));
});

it('shows a retryable read error instead of claiming the task was deleted', async () => {
  source.taskGet = async () => { throw new Error('network down'); };
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  expect(container.textContent).toContain('network down');
  expect(container.textContent).not.toContain(i18n.t('emailTaskNotFound'));
  source.taskGet = async () => undefined;
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('retry'))!;
  await act(() => retry.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.textContent).toContain(i18n.t('emailTaskNotFound'));
});

it('previews the same public ICS URL as the copy-link action', async () => {
  source.taskGet = async () => ({
    id: 'task-1', configId: 'config-1', daysOfWeek: [1], emails: [], recentTimes: 0,
    templateText: '{{ scheduleIcsUrl }}', metadata: { serveScheduleIcs: true },
  });
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  expect(container.textContent).toContain(`${window.location.origin}/public/email-tasks/task-1/schedule.ics`);
  expect(container.textContent).not.toContain('example.com/public/email-tasks');
});

it('shows ICS settings only while enabled and preserves the template across toggles', async () => {
  source.taskGet = async () => ({
    id: 'task-1', configId: 'config-1', daysOfWeek: [1], emails: [], recentTimes: 0,
    templateText: 'hello', metadata: { serveScheduleIcs: true, icsContentTemplate: 'Zoom room' },
  });
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const icsLabel = [...container.querySelectorAll('label')].find(element => element.textContent === i18n.t('emailTaskServeScheduleIcs'))!;
  const checkbox = icsLabel.parentElement!.querySelector('input[type="checkbox"]')!;
  expect(container.querySelector('#ics-link-mode')).not.toBeNull();
  expect(EditorView.findFromDOM(container.querySelector('.cm-editor')!)?.state.doc.toString()).toBe('Zoom room');
  expect([...container.querySelectorAll('button')].filter(button => button.textContent === i18n.t('emailTaskInsertIcsLink'))).toHaveLength(1);

  await act(() => checkbox.click());
  expect(container.querySelector('#ics-link-mode')).toBeNull();
  await act(() => checkbox.click());
  expect(container.querySelector('#ics-link-mode')).not.toBeNull();
  expect(EditorView.findFromDOM(container.querySelector('.cm-editor')!)?.state.doc.toString()).toBe('Zoom room');
});

it('uses one stable task-enabled checkbox label with checked meaning enabled', async () => {
  source.taskGet = async () => ({
    id: 'task-1', configId: 'config-1', daysOfWeek: [1], emails: [], recentTimes: 0,
    disabled: true, templateText: 'hello', metadata: {},
  });
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const label = [...container.querySelectorAll('label')].find(element => element.textContent === i18n.t('emailTaskEnabled'))!;
  const checkbox = label.querySelector('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(false);
  await act(() => checkbox.click());
  expect(checkbox.checked).toBe(true);
  expect(label.textContent).toBe(i18n.t('emailTaskEnabled'));
});

it('saves all ICS form values even when the public link is switched off', async () => {
  source.taskGet = async () => ({
    id: 'task-1', configId: 'config-1', daysOfWeek: [1], emails: [], recentTimes: 0,
    templateText: 'hello', metadata: { serveScheduleIcs: true, icsContentTemplate: 'Old room' },
  });
  const saved: unknown[] = [];
  source.taskPut = async (task) => { saved.push(task); };
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const mode = container.querySelector('#ics-link-mode') as HTMLSelectElement;
  await act(() => { mode.value = 'meeting'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  await act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'New room' } }));
  const icsLabel = [...container.querySelectorAll('label')].find(element => element.textContent === i18n.t('emailTaskServeScheduleIcs'))!;
  await act(() => icsLabel.parentElement!.querySelector('input[type="checkbox"]')!.click());
  const unsavedEvent = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unsavedEvent);
  expect(unsavedEvent.defaultPrevented).toBe(true);
  await act(async () => {
    [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('save'))!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ metadata: {
    serveScheduleIcs: false,
    icsLinkMode: 'meeting',
    icsContentTemplate: 'New room',
  } });
  const savedEvent = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(savedEvent);
  expect(savedEvent.defaultPrevented).toBe(false);
});

it('opens a separate ICS preview and an ICS variable reference', async () => {
  source.taskGet = async () => ({
    id: 'task-1', configId: 'config-1', daysOfWeek: [1], emails: [], recentTimes: 0,
    templateText: 'hello', metadata: { serveScheduleIcs: true, icsContentTemplate: 'Join {{ sessionDate }}' },
  });
  source.configs = [{ id: 'config-1', daysOfWeek: [1], timeRange: ['09:00', '10:00'], timezone: 'Asia/Tokyo', metadata: {} }];
  source.persons = [{ id: 'alice', name: 'Alice', metadata: {}, keywordIds: [] }];
  source.schedules = [{ id: 'plan-1', configId: 'config-1', createdAt: Date.UTC(2026, 0, 1), sessions: [
    { date: '2026-01-05', presentations: [{ presenterId: 'alice', questionerIds: [] }] },
  ] }];
  const container = mount();
  await act(() => render(<EmailTaskEditPage taskId="task-1" />, container));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const preview = [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('emailTaskIcsPreview'))!;
  await act(() => preview.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('DESCRIPTION:Join 2026-01-05');
  await act(() => (document.querySelector('[role="dialog"] button[aria-label]') as HTMLButtonElement).click());

  const icsEditorGroup = preview.closest('div[class]')?.parentElement;
  const variables = [...(icsEditorGroup?.querySelectorAll('button') ?? [])].find(button => button.textContent === i18n.t('templateVariableReference'))!;
  await act(() => variables.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('sessionDate');
});

it('waits for person relations before publishing a person row', async () => {
  const person = { id: 'p1', name: 'Person', names: { en: 'Person' }, keywordIds: ['kw1'], tagIds: [], metadata: {} };
  source.personsList = async () => ({ items: [person], total: 1 });
  source.keywords = [{ id: 'kw1', name: 'Research', names: { en: 'Research' }, metadata: {} }];
  let finish!: (bundle: unknown) => void;
  source.personBundle = () => new Promise(resolve => { finish = resolve; });
  const container = mount();

  await act(() => render(<PersonsTab />, container));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.textContent).not.toContain('kw1');

  await act(async () => {
    finish({ keywords: source.keywords, personTags: [], referencedPersonIds: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain('Research');
  expect(container.textContent).not.toContain('kw1');
});

it('does not expose a savable default timezone before settings arrive', async () => {
  let finish!: (settings: unknown) => void;
  source.settingsGet = () => new Promise(resolve => { finish = resolve; });
  const container = mount();
  await act(() => render(<SettingsPage />, container));

  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => {
    finish({ timezone: 'Asia/Tokyo' });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.querySelector('select')?.value).toBe('Asia/Tokyo');
});
