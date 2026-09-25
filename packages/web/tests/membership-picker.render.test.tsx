import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test } from 'vitest';
import { PersonMembershipPicker } from '../src/components/PersonMembershipPicker';

const person = { id: 'p', name: 'Alice', names: { en: 'Alice' }, metadata: {}, keywordIds: [] };
const tag = { id: 't', name: 'Physics', names: { en: 'Physics' }, color: '#336699' };
const mounted: HTMLDivElement[] = [];

afterEach(async () => {
  for (const container of mounted.splice(0)) {
    await act(() => render(null, container));
    container.remove();
  }
});

test('person picker enables tag membership only when requested', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  let personIds: string[] = [];
  let tagIds: string[] = [];
  const draw = (allowTags: boolean) => render(<PersonMembershipPicker persons={[person]} selectedIds={personIds}
    onChange={ids => { personIds = ids; draw(allowTags); }}
    allowTags={allowTags} tags={[tag]} selectedTagIds={tagIds}
    onTagChange={ids => { tagIds = ids; draw(allowTags); }} />, container);
  await act(() => draw(false));
  expect(container.textContent).toContain('Alice');
  expect(container.textContent).not.toContain('Physics');
  await act(() => draw(true));
  const buttons = [...container.querySelectorAll('button')];
  await act(() => buttons.find(button => button.textContent === 'Alice')!.click());
  await act(() => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Physics'))!.click());
  expect(personIds).toEqual(['p']);
  expect(tagIds).toEqual(['t']);
});
