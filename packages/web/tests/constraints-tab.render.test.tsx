import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test, vi } from 'vitest';

const source = vi.hoisted(() => ({
  people: [
    { id: 'p1', name: 'Alice', names: { en: 'Alice' }, metadata: {}, keywordIds: [], tagIds: ['a'] },
    { id: 'p2', name: 'Bob', names: { en: 'Bob' }, metadata: {}, keywordIds: [], tagIds: ['b'] },
  ],
  tags: [
    { id: 'a', name: 'Physics', names: { en: 'Physics' }, color: '#336699' },
    { id: 'b', name: 'CS', names: { en: 'CS' }, color: '#663399' },
  ],
  constraints: [{ id: 'pair', type: 'affinity-boost', groups: [
    { personIds: [], tagIds: ['a'] }, { personIds: [], tagIds: ['b'] },
  ], boost: 2 }],
}));

vi.mock('@/db', () => {
  const db = { persons: { kind: 'persons' }, personTags: { kind: 'tags' }, configs: { kind: 'configs' }, constraints: { kind: 'constraints' } };
  return {
    useDatabase: () => db,
    listConstraintsPage: async () => ({ items: source.constraints, total: source.constraints.length }),
    readAllPaginated: async (store: { kind: string }) => store.kind === 'persons' ? source.people : store.kind === 'tags' ? source.tags : [],
  };
});

import { ConstraintsTab } from '../src/pages/person/ConstraintsTab';

const mounted: HTMLDivElement[] = [];
afterEach(async () => {
  for (const container of mounted.splice(0)) {
    await act(() => render(null, container));
    container.remove();
  }
});

test('pair summary uses separate group rows and multiplier has explicit neutral value', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  await act(() => render(<ConstraintsTab />, container));
  await act(async () => { await Promise.resolve(); });
  const summary = container.querySelector('tbody tr td:nth-child(3)')!;
  expect(summary.textContent).toContain('Group 1');
  expect(summary.textContent).toContain('Group 2');
  expect(summary.textContent).not.toContain('↔');
  await act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Edit')!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Pairing preference multiplier');
  expect(dialog.textContent).toContain('1 leaves pairing unchanged');
  const multiplier = dialog.querySelector('input[type="number"]') as HTMLInputElement;
  await act(() => { multiplier.value = '0'; multiplier.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(multiplier.getAttribute('aria-invalid')).toBe('true');
  expect([...dialog.querySelectorAll('button')].find(button => button.textContent === 'Save')?.disabled).toBe(true);
});
