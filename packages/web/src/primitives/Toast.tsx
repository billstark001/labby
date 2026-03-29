/**
 * Toast — headless notification primitive.
 *
 * Mount <Toaster /> once at the app root, then call toast.success / toast.error anywhere.
 *
 * Usage:
 *   import { toast, Toaster } from './Toast';
 *
 *   // In App root:
 *   <Toaster />
 *
 *   // Anywhere:
 *   toast.success('Saved!')
 *   toast.error('Something went wrong')
 */
import { signal } from '@preact/signals';
import { X } from 'lucide-preact';

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}

let _nextId = 0;
const _toasts = signal<ToastItem[]>([]);

function add(
  message: string,
  type: ToastItem['type'] = 'info',
  duration = 3500,
): number {
  const id = ++_nextId;
  _toasts.value = [..._toasts.value, { id, message, type }];
  if (duration > 0) setTimeout(() => remove(id), duration);
  return id;
}

function remove(id: number): void {
  _toasts.value = _toasts.value.filter(t => t.id !== id);
}

export const toast = {
  success: (msg: string, dur?: number) => add(msg, 'success', dur),
  error: (msg: string, dur?: number) => add(msg, 'error', dur),
  info: (msg: string, dur?: number) => add(msg, 'info', dur),
  warning: (msg: string, dur?: number) => add(msg, 'warning', dur),
  dismiss: remove,
};

function ToastEntry({ id, message, type }: ToastItem) {
  return (
    <div
      role="alert"
      aria-live="polite"
      data-type={type}
      onClick={() => toast.dismiss(id)}
      style={{
        cursor: 'pointer',
      }}
    >
      <span>{message}</span>
      <span aria-hidden="true"><X size={14} /></span>
    </div>
  );
}

/** Mount once at the app root. */
export function Toaster() {
  return (
    <div
      aria-label="Notifications"
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 9999,
      }}
    >
      {_toasts.value.map(t => <ToastEntry key={t.id} {...t} />)}
    </div>
  );
}
