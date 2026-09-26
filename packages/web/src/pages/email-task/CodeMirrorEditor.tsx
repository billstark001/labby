import { useLayoutEffect, useRef } from 'preact/hooks';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { vars } from '@/styles/theme.css';

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
}

function changedRange(current: string, next: string) {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from += 1;

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > from && nextEnd > from && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return { from, to: currentEnd, insert: next.slice(from, nextEnd) };
}

export function CodeMirrorEditor({ value, onChange }: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const externalUpdate = useRef(false);
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.theme({
            '&': {
              border: `1px solid ${vars.color.border}`,
              borderRadius: '8px',
              minHeight: '260px',
              fontSize: '13px',
              backgroundColor: vars.color.surface,
              color: vars.color.text,
            },
            '&.cm-focused': { outline: `2px solid ${vars.color.primary}` },
            '.cm-content': { minHeight: '240px' },
            '.cm-gutters': {
              backgroundColor: vars.color.surface,
              color: vars.color.textMuted,
              borderRight: `1px solid ${vars.color.border}`,
            },
            '.cm-activeLineGutter': { backgroundColor: vars.color.background },
            '.cm-cursor': { borderLeftColor: vars.color.text },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalUpdate.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === value) return;
    externalUpdate.current = true;
    try {
      view.dispatch({ changes: changedRange(currentDoc, value) });
    } finally {
      externalUpdate.current = false;
    }
  }, [value]);

  return <div ref={hostRef} />;
}
