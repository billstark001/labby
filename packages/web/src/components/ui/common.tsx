/** Shared UI building blocks. */
import { h } from 'preact';
import * as s from '../../styles/components.css';

export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';
export { ResponsiveDataField, ResponsiveDataView, responsiveDataStyles } from './ResponsiveData';
export type { ResponsiveDataColumn } from './ResponsiveData';

interface ButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
}

export function Button({ variant = 'primary', class: cls, ...rest }: ButtonProps) {
  return (
    <button
      class={[s.btnVariants[variant], cls].filter(Boolean).join(' ')}
      {...rest}
    />
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
