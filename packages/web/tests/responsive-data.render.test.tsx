import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';
import { ResponsiveDataView } from '../src/components/ui/ResponsiveData';

it('desktop headers and mobile controls share controlled sort state, including an empty page', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  function Harness() {
    const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({
      key: 'date',
      direction: 'desc',
    });
    return (
      <ResponsiveDataView
        items={[]}
        columns={[
          { header: 'Name', sortKey: 'name' },
          { header: 'Date', sortKey: 'date' },
          { header: 'Unsortable' },
        ]}
        sorting={{
          ...sort,
          options: [
            { key: 'name', label: 'Name' },
            { key: 'date', label: 'Date', defaultDirection: 'desc' },
          ],
          onChange: (key, direction) => setSort({ key, direction }),
        }}
        getKey={String}
        renderDesktopRow={() => null}
        renderMobileCard={() => null}
      />
    );
  }
  try {
    await act(() => render(<Harness />, container));
    const headers = container.querySelectorAll('th');
    expect(headers[1]!.getAttribute('aria-sort')).toBe('descending');
    expect(headers[2]!.querySelector('button')).toBeNull();
    await act(() => headers[0]!.querySelector('button')!.click());
    expect(headers[0]!.getAttribute('aria-sort')).toBe('ascending');
    await act(() => headers[0]!.querySelector('button')!.click());
    expect(headers[0]!.getAttribute('aria-sort')).toBe('descending');
    const [column, direction] = container.querySelectorAll('select');
    await act(() => {
      column!.value = 'date';
      column!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(headers[1]!.getAttribute('aria-sort')).toBe('descending');
    await act(() => {
      direction!.value = 'asc';
      direction!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(headers[1]!.getAttribute('aria-sort')).toBe('ascending');
  } finally {
    await act(() => render(null, container));
    container.remove();
  }
});
