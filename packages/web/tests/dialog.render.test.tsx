import 'preact/debug';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';

import { Dialog } from '../src/components/ui/Dialog';

it('dialog has a labelled fixed shell and restores focus and page scrolling', async () => {
  const container = document.createElement('div');
  document.body.append(container);

  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button id="opener" onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog
        open
        title="Edit record"
        description="Change the fields"
        onClose={() => setOpen(false)}
        actions={<button id="save">Save</button>}
      >
        <input aria-label="Name" />
      </Dialog>}
    </>;
  }

  try {
    await act(() => render(<Harness />, container));
    const opener = container.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    await act(() => opener.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(title.textContent).toBe('Edit record');
    expect(description.textContent).toBe('Change the fields');
    expect(document.body.style.overflow).toBe('hidden');

    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    const save = dialog.querySelector<HTMLButtonElement>('#save')!;
    close.focus();
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(save);

    await act(() => close.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  } finally {
    await act(() => render(null, container));
    container.remove();
    document.body.style.overflow = '';
  }
});
