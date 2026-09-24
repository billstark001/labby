import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, test } from 'vitest';
import { ConfirmDialogComponent, closeConfirmDialog, confirmDialog } from '../src/components/ui/Dialog';

const container = document.createElement('div');
document.body.append(container);
afterEach(async () => {
  closeConfirmDialog();
  await act(() => render(null, container));
});

test('confirmation stays visible and busy until an asynchronous mutation succeeds', async () => {
  let finish!: () => void;
  confirmDialog('Remove item', 'Confirm removal', () => new Promise<void>(resolve => { finish = resolve; }));
  await act(() => render(<ConfirmDialogComponent />, container));
  const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === 'Delete')!;
  await act(() => confirm.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(confirm.getAttribute('aria-busy')).toBe('true');
  await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test('failed confirmation remains open and reports its error', async () => {
  confirmDialog('Remove item', 'Confirm removal', async () => { throw new Error('delete blocked'); });
  await act(() => render(<ConfirmDialogComponent />, container));
  const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === 'Delete')!;
  await act(async () => { confirm.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('delete blocked');
});
