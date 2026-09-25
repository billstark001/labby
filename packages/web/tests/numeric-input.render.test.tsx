import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, test, vi } from 'vitest';
import { NumericInput } from '../src/components/ui/NumericInput';

test('numeric input remains empty while editing and restores its previous value on blur', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const onValueInput = vi.fn();
  await act(() => render(<NumericInput value={0} onValueInput={onValueInput} />, container));
  const input = container.querySelector('input')!;

  await act(() => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('');
  expect(onValueInput).not.toHaveBeenCalled();
  await act(() => render(<NumericInput value={0} onValueInput={onValueInput} />, container));
  expect(input.value).toBe('');

  await act(() => {
    input.value = '12';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('12');
  expect(onValueInput).toHaveBeenCalledWith('12');

  await act(() => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur'));
  });
  expect(input.value).toBe('0');
  await act(() => render(null, container));
  container.remove();
});
