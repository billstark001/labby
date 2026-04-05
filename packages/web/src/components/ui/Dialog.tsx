/** Business-layer Dialog wrapper and utilities. */
import { type ComponentChildren } from 'preact';
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
import { i18n } from '@/i18n';

// Re-export primitive components for convenience
export { useDialog, type DialogHandle };
export { PrimitiveDialogOverlay as DialogOverlay, PrimitiveDialogDescription as DialogDescription };

// Business wrapper for the full dialog component
interface DialogProps {
  open: boolean;
  onClose: () => void;
  closeOnOverlayClick?: boolean;
  title?: ComponentChildren;
  description?: ComponentChildren;
  children: ComponentChildren;
  actions?: ComponentChildren;
  width?: string | number;
}

export function Dialog({ open, onClose, closeOnOverlayClick = true, title, description, children, actions, width }: DialogProps) {
  const widthStyle = width
    ? { width: typeof width === 'number' ? `${width}px` : width }
    : undefined;
  return (
    <PrimitiveDialog open={open} onClose={onClose} closeOnOverlayClick={closeOnOverlayClick}>
      <PrimitiveDialogOverlay class={s.dialogOverlay} />
      <PrimitiveDialogContent class={s.dialogContent} style={widthStyle}>
        {title && <PrimitiveDialogTitle class={s.dialogTitle}>{title}</PrimitiveDialogTitle>}
        {description && <PrimitiveDialogDescription class={s.dialogDescription}>{description}</PrimitiveDialogDescription>}
        {children}
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
  onConfirm: () => void;
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
  onConfirm: () => void,
  onCancel?: () => void,
): void {
  confirmDialogState.value = {
    isOpen: true,
    title,
    message,
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

  if (!state || !state.isOpen) return null;

  const handleConfirm = () => {
    state.onConfirm();
    closeConfirmDialog();
  };

  const handleCancel = () => {
    state.onCancel?.();
    closeConfirmDialog();
  };

  return (
    <Dialog
      open={state.isOpen}
      onClose={handleCancel}
      title={state.title}
      description={state.message}
      children={<div class={s.dialogBody} />}
      actions={
        <>
          <button class={btnStyles.btnVariants.secondary} onClick={handleCancel}>
            {t('cancel')}
          </button>
          <button class={btnStyles.btnVariants.danger} onClick={handleConfirm}>
            {t('confirm')}
          </button>
        </>
      }
    />
  );
}
