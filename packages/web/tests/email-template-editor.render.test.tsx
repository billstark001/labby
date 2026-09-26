import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, test, vi } from 'vitest';
import { CodeMirrorEditor } from '../src/pages/email-task/CodeMirrorEditor';

const container = document.createElement('div');
document.body.append(container);

afterEach(async () => {
  await act(() => render(null, container));
});

test('external template append retains the current cursor and does not report an edit', async () => {
  const onChange = vi.fn();
  await act(() => render(<CodeMirrorEditor value={'first\nsecond'} onChange={onChange} />, container));
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
  expect(view).not.toBeNull();
  view!.dispatch({ selection: { anchor: 8 } });

  await act(() => render(<CodeMirrorEditor value={'first\nsecond\nnew row'} onChange={onChange} />, container));

  expect(view!.state.doc.toString()).toBe('first\nsecond\nnew row');
  expect(view!.state.selection.main.head).toBe(8);
  expect(onChange).not.toHaveBeenCalled();
});

test('editor edits flow to the latest callback without cursor movement from a value echo', async () => {
  const initialOnChange = vi.fn();
  const onChange = vi.fn();
  await act(() => render(<CodeMirrorEditor value={'first\nsecond'} onChange={initialOnChange} />, container));
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  await act(() => render(<CodeMirrorEditor value={'first\nsecond'} onChange={onChange} />, container));

  view.dispatch({ changes: { from: 8, insert: 'X' }, selection: { anchor: 9 } });
  expect(onChange).toHaveBeenCalledWith('first\nseXcond');
  expect(initialOnChange).not.toHaveBeenCalled();

  await act(() => render(<CodeMirrorEditor value={'first\nseXcond'} onChange={onChange} />, container));
  expect(view.state.selection.main.head).toBe(9);
});
