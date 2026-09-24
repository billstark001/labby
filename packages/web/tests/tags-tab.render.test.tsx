import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test, vi } from 'vitest';

const source = vi.hoisted(() => ({
  tags: [{ id: 'tag-local', name: 'Local', names: { en: 'Local', zh: '本地', ja: '地元' }, color: '#a45132', notes: 'Group' }, { id: 'tag-grad', name: 'Graduate', names: { en: 'Graduate', zh: '毕业生', ja: '卒業生' }, color: '#396eae' }],
  people: [{ id: 'p1', tagIds: ['tag-local'] }, { id: 'p2', tagIds: ['tag-local', 'tag-grad'] }],
  put: async (_tag: unknown): Promise<void> => {},
}));

vi.mock('@/db', () => {
  const db = {
    personTags: { kind: 'tags', put: (tag: unknown) => source.put(tag) },
    persons: { kind: 'people' },
  };
  return {
    useDatabase: () => db,
    readAllPaginated: async (store: { kind: string }) => store.kind === 'tags' ? source.tags : source.people,
  };
});

import { TagsTab, randomTagColor } from '../src/pages/person/TagsTab';
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
  source.put = async () => {};
});

test('tag tab shows members, search, and a persistent list outside its editor', async () => {
  const container = mount();
  await act(() => render(<TagsTab />, container));
  await act(async () => { await Promise.resolve(); });
  expect(container.textContent).toContain('Local');
  expect(container.querySelectorAll('tbody tr')[1]?.textContent).toContain('Local2');
  const search = container.querySelector('input[type="search"]') as HTMLInputElement;
  await act(() => { search.value = 'grad'; search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).toContain('Graduate');
  expect(container.textContent).not.toContain('Local');
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('addPersonTag'))!;
  await act(() => add.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain('Graduate');
});

test('new tag colors vary and save exposes pending state', async () => {
  expect(new Set(Array.from({ length: 24 }, randomTagColor)).size).toBeGreaterThan(1);
  const container = mount();
  await act(() => render(<TagsTab />, container));
  await act(async () => { await Promise.resolve(); });
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === i18n.t('addPersonTag'))!;
  await act(() => add.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  const name = dialog.querySelector('input:not([type="color"])') as HTMLInputElement;
  await act(() => { name.value = 'Visitor'; name.dispatchEvent(new Event('input', { bubbles: true })); });
  let finish!: () => void;
  source.put = () => new Promise<void>(resolve => { finish = resolve; });
  const save = [...dialog.querySelectorAll('button')].find(button => button.textContent === i18n.t('save'))!;
  await act(() => save.click());
  expect(save.getAttribute('aria-busy')).toBe('true');
  await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
