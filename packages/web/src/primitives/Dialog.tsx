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
  labelledBy?: string;
  describedBy?: string;
}

const DialogCtx = createContext<DialogContextValue | null>(null);

interface DialogProps {
  open: boolean;
  onClose: () => void;
  closeOnOverlayClick?: boolean;
  labelledBy?: string;
  describedBy?: string;
  children: ComponentChildren;
}

export function Dialog({ open, onClose, closeOnOverlayClick = true, labelledBy, describedBy, children }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <DialogCtx.Provider value={{ onClose, closeOnOverlayClick, labelledBy, describedBy }}>
      {children}
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
  const ctx = useContext(DialogCtx)!;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute('hidden'));
    if (focusable.length === 0) {
      event.preventDefault();
      ref.current.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={ctx.labelledBy}
      aria-describedby={ctx.describedBy}
      tabIndex={-1}
      class={cls}
      style={extra}
      onKeyDown={trapFocus}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ children, class: cls, id }: { children: ComponentChildren; class?: string; id?: string }) {
  return <h2 class={cls} id={id}>{children}</h2>;
}

export function DialogDescription({ children, class: cls, id }: { children: ComponentChildren; class?: string; id?: string }) {
  return <p class={cls} id={id}>{children}</p>;
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
