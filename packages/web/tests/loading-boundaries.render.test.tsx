import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  taskGet: (_id: string): Promise<unknown> => Promise.resolve(undefined),
  personsList: (_query: unknown): Promise<unknown> => Promise.resolve({ items: [], total: 0 }),
  personBundle: (_ids: string[]): Promise<unknown> => Promise.resolve({
    keywords: [], personTags: [], referencedPersonIds: [],
  }),
  settingsGet: (): Promise<unknown> => Promise.resolve({ timezone: 'UTC' }),
  keywords: [] as unknown[],
}));

vi.mock('@/db', () => {
  const emptyStore = { list: async () => ({ items: [], total: 0 }) };
  const db = {
    emailTasks: { get: (id: string) => source.taskGet(id), ...emptyStore },
    configs: emptyStore,
    persons: emptyStore,
    schedules: emptyStore,
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
  source.personsList = async () => ({ items: [], total: 0 });
  source.personBundle = async () => ({ keywords: [], personTags: [], referencedPersonIds: [] });
  source.keywords = [];
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
