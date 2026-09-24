/** Business-layer Dialog wrapper and utilities. */
import { type ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  Dialog as PrimitiveDialog,
  DialogOverlay as PrimitiveDialogOverlay,
  DialogContent as PrimitiveDialogContent,
  DialogTitle as PrimitiveDialogTitle,
  DialogDescription as PrimitiveDialogDescription,
  useDialog,
  type DialogHandle,
} from '../../primitives/Dialog';
import * as s from './Dialog.css';
import * as btnStyles from '../../styles/components.css';
import { Button } from './common';
import { i18n } from '@/i18n';
import { X } from 'lucide-preact';

// Re-export primitive components for convenience
export { useDialog, type DialogHandle };
export { PrimitiveDialogOverlay as DialogOverlay, PrimitiveDialogDescription as DialogDescription };

// Business wrapper for the full dialog component
interface DialogProps {
  open: boolean;
  onClose: () => void;
  closeOnOverlayClick?: boolean;
  title: ComponentChildren;
  description?: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  width?: string | number;
}

export function Dialog({ open, onClose, closeOnOverlayClick = true, title, description, children, actions, width }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const widthStyle = width
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined;
  return (
    <PrimitiveDialog
      open={open}
      onClose={onClose}
      closeOnOverlayClick={closeOnOverlayClick}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
    >
      <PrimitiveDialogOverlay class={s.dialogOverlay} />
      <PrimitiveDialogContent class={s.dialogContent} style={widthStyle}>
        <header class={s.dialogHeader}>
          <PrimitiveDialogTitle class={s.dialogTitle} id={titleId}>{title}</PrimitiveDialogTitle>
          <button class={s.dialogClose} type="button" onClick={onClose} aria-label={i18n.t('close')}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {(description || children) && <div class={s.dialogBody}>
          {description && <PrimitiveDialogDescription class={s.dialogDescription} id={descriptionId}>{description}</PrimitiveDialogDescription>}
          {children}
        </div>}
        {actions && <div class={s.dialogActions}>{actions}</div>}
      </PrimitiveDialogContent>
    </PrimitiveDialog>
  );
}

// ---------------------------------------------------------------------------
// Confirm Dialog Hook & Factory
// ---------------------------------------------------------------------------

type ConfirmDialogState = {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
} | null;

const confirmDialogState = signal<ConfirmDialogState>(null);

/**
 * Show a confirmation dialog and wait for user response.
 *
 * @example
 * confirmDialog(
 *   'Delete Person?',
 *   'This action cannot be undone.',
 *   () => { deletePerson(id); },
 *   () => { console.log('Cancelled'); }
 * );
 */
export function confirmDialog(
  title: string,
  message: string,
  onConfirm: () => void | Promise<void>,
  onCancel?: () => void,
  confirmLabel?: string,
): void {
  confirmDialogState.value = {
    isOpen: true,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  };
}

/**
 * Hook to manage a confirmation dialog.
 *
 * @example
 * export function ConfirmDialogProvider() {
 *   const state = useConfirmDialog();
 *   if (!state) return null;
 *   return <ConfirmDialog state={state} />;
 * }
 */
export function useConfirmDialog(): ConfirmDialogState | null {
  return confirmDialogState.value;
}

/**
 * Close the current confirmation dialog.
 */
export function closeConfirmDialog(): void {
  confirmDialogState.value = null;
}

// ---------------------------------------------------------------------------
// Confirm Dialog Component
// ---------------------------------------------------------------------------

export function ConfirmDialogComponent() {
  const { t } = i18n;
  const state = confirmDialogState.value;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state || !state.isOpen) return null;

  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await state.onConfirm();
      closeConfirmDialog();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  const handleCancel = () => {
    if (pending) return;
    state.onCancel?.();
    setError(null);
    closeConfirmDialog();
  };

  return (
    <Dialog
      open={state.isOpen}
      onClose={handleCancel}
      title={state.title}
      description={state.message}
      children={error && <p role="alert" class={btnStyles.textDanger}>{error}</p>}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" busy={pending} onClick={() => void handleConfirm()}>
            {state.confirmLabel ?? t('delete')}
          </Button>
        </>
      }
    />
  );
}
