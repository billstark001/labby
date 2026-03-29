/**
 * Dialog — headless modal primitive, close to the Radix UI API.
 *
 * Usage:
 *   const dialog = useDialog();
 *
 *   <button onClick={dialog.open}>Open</button>
 *   <Dialog open={dialog.isOpen.value} onClose={dialog.close}>
 *     <DialogOverlay />
 *     <DialogContent>
 *       <DialogTitle>Title</DialogTitle>
 *       <DialogDescription>Body text</DialogDescription>
 *       <button onClick={dialog.close}>Close</button>
 *     </DialogContent>
 *   </Dialog>
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { useSignal, type Signal } from '@preact/signals';
import type { CSSProperties } from 'preact';

interface DialogContextValue {
  onClose: () => void;
  closeOnOverlayClick: boolean;
}

const DialogCtx = createContext<DialogContextValue | null>(null);

interface DialogProps {
  open: boolean;
  onClose: () => void;
  closeOnOverlayClick?: boolean;
  children: ComponentChildren;
}

export function Dialog({ open, onClose, closeOnOverlayClick = true, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <DialogCtx.Provider value={{ onClose, closeOnOverlayClick }}>
      <div role="dialog" aria-modal="true">
        {children}
      </div>
    </DialogCtx.Provider>
  );
}

export function DialogOverlay({ style: extra, class: cls }: { style?: CSSProperties; class?: string }) {
  const ctx = useContext(DialogCtx)!;
  return (
    <div
      aria-hidden="true"
      onClick={() => {
        if (ctx.closeOnOverlayClick) ctx.onClose();
      }}
      class={cls}
      style={extra}
    />
  );
}

export function DialogContent({ children, style: extra, class: cls }: { children: ComponentChildren; style?: CSSProperties; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      class={cls}
      style={extra}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <h2 class={cls}>{children}</h2>;
}

export function DialogDescription({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <p class={cls}>{children}</p>;
}

// ---------------------------------------------------------------------------
// useDialog hook
// ---------------------------------------------------------------------------

export interface DialogHandle {
  isOpen: Signal<boolean>;
  open: () => void;
  close: () => void;
}

export function useDialog(): DialogHandle {
  const isOpen = useSignal(false);
  return {
    isOpen,
    open: () => { isOpen.value = true; },
    close: () => { isOpen.value = false; },
  };
}
