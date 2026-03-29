/**
 * Toast — business-layer wrapper around the Toast primitive.
 *
 * Provides styled toasts with success/error/info/warning/loading variants.
 * Mount <Toaster /> once at the app root (already done in App.tsx via this module).
 *
 * Usage:
 *   import { toast } from '@/components/ui/Toast';
 *   toast.success('Saved!');
 *   const id = toast.loading('Computing…');
 *   toast.dismiss(id);
 */
import { signal } from '@preact/signals';
import { X, Loader } from 'lucide-preact';
import * as css from './Toast.css.js';

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let _nextId = 0;
const _toasts = signal<ToastItem[]>([]);

function add(message: string, type: ToastType = 'info', duration = 3500): number {
  const id = ++_nextId;
  _toasts.value = [..._toasts.value, { id, message, type }];
  // loading toasts stay until manually dismissed
  if (duration > 0 && type !== 'loading') {
    setTimeout(() => remove(id), duration);
  }
  return id;
}

function remove(id: number): void {
  _toasts.value = _toasts.value.filter(t => t.id !== id);
}

export const toast = {
  success: (msg: string, dur?: number) => add(msg, 'success', dur),
  error:   (msg: string, dur?: number) => add(msg, 'error',   dur),
  info:    (msg: string, dur?: number) => add(msg, 'info',    dur),
  warning: (msg: string, dur?: number) => add(msg, 'warning', dur),
  loading: (msg: string) => add(msg, 'loading', 0),
  dismiss: remove,
};

function ToastEntry({ id, message, type }: ToastItem) {
  const cls = css.toastVariants[type];
  return (
    <div class={cls} onClick={() => toast.dismiss(id)}>
      {type === 'loading' && <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />}
      <span class={css.toastMessage}>{message}</span>
      <span class={css.toastClose} aria-hidden="true"><X size={14} /></span>
    </div>
  );
}

/** Mount once at the app root. */
export function Toaster() {
  return (
    <div class={css.toastContainer} aria-label="Notifications" aria-live="polite">
      {_toasts.value.map(t => <ToastEntry key={t.id} {...t} />)}
    </div>
  );
}
