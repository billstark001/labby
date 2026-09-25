/** Shared UI building blocks. */
import { h } from 'preact';
import { LoaderCircle } from 'lucide-preact';
import * as s from '../../styles/components.css';
import { spinningIcon } from './Toast.css';

export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';
export { ResponsiveDataField, ResponsiveDataView, responsiveDataStyles } from './ResponsiveData';
export type { ResponsiveDataColumn, DataSorting } from './ResponsiveData';

interface ButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
}

export function Button({ variant = 'primary', class: cls, busy = false, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      class={[s.btnVariants[variant], cls].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy}
      {...rest}
    >{busy && <LoaderCircle size={14} class={spinningIcon} />}{busy ? ' ' : null}{children}</button>
  );
}

export function Card({
  children,
  class: cls,
  ...rest
}: h.JSX.HTMLAttributes<HTMLDivElement>) {
  return (
    <div class={[s.card, cls].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}
