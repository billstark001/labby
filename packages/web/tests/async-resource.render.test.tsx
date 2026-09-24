import 'preact/debug';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';

import { useAsyncResource } from '../src/lib/use-async-resource';

it('async resources show loading before effects and never show data for another key', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const resolvers = new Map<number, (value: string) => void>();

  function Harness() {
    const [key, setKey] = useState(0);
    const resource = useAsyncResource(
      () => new Promise<string>((resolve) => resolvers.set(key, resolve)),
      [key],
    );
    return <div>
      <button onClick={() => setKey((value) => value + 1)}>Next</button>
      <span data-status={resource.status} data-loading={resource.isInitialLoading}>{resource.data ?? 'empty'}</span>
    </div>;
  }

  try {
    await act(() => {
      render(<Harness />, container);
      expect(container.querySelector('span')!.dataset.status).toBe('idle');
      expect(container.querySelector('span')!.dataset.loading).toBe('true');
    });
    await act(async () => { resolvers.get(0)!('zero'); });
    expect(container.querySelector('span')!.textContent).toBe('zero');

    await act(() => container.querySelector('button')!.click());
    expect(container.querySelector('span')!.dataset.status).toBe('pending');
    expect(container.querySelector('span')!.dataset.loading).toBe('true');
    expect(container.querySelector('span')!.textContent).toBe('empty');
    await act(() => container.querySelector('button')!.click());

    await act(async () => { resolvers.get(2)!('two'); });
    await act(async () => { resolvers.get(1)!('one'); });
    expect(container.querySelector('span')!.dataset.status).toBe('success');
    expect(container.querySelector('span')!.textContent).toBe('two');
  } finally {
    await act(() => render(null, container));
    container.remove();
  }
});

it('async resources keep successful data during a same-key refetch', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const resolvers: Array<(value: string) => void> = [];
  function Harness() {
    const resource = useAsyncResource(() => new Promise<string>(resolve => resolvers.push(resolve)));
    return <div>
      <button onClick={() => void resource.refetch()}>Refresh</button>
      <span data-status={resource.status}>{resource.data ?? 'empty'}</span>
    </div>;
  }
  try {
    await act(() => render(<Harness />, container));
    await act(async () => { resolvers[0]!('first'); });
    await act(() => container.querySelector('button')!.click());
    expect(container.querySelector('span')!.dataset.status).toBe('pending');
    expect(container.querySelector('span')!.textContent).toBe('first');
  } finally {
    await act(() => render(null, container));
    container.remove();
  }
});
