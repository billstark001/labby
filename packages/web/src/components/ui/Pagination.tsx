import { type ComponentChildren } from 'preact';
import clsx from 'clsx';
import * as base from '../../styles/components.css';
import * as s from './Pagination.css';

type PaginationItem = number | 'ellipsis';

interface PaginationLabels {
  previous?: ComponentChildren;
  next?: ComponentChildren;
  pageSize?: ComponentChildren;
  summary?: (start: number, end: number, totalItems: number) => ComponentChildren;
}

export interface PaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  labels?: PaginationLabels;
  class?: string;
}

function getPaginationItems(page: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (page <= 3) {
    return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
  }

  if (page >= totalPages - 2) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages];
}

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  labels,
  class: className,
}: PaginationProps) {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = totalItems === 0 ? 0 : (currentPage - 1) * safePageSize + 1;
  const end = totalItems === 0 ? 0 : Math.min(currentPage * safePageSize, totalItems);
  const items = getPaginationItems(currentPage, totalPages);

  return (
    <nav class={clsx(s.root, className)} aria-label="Pagination">
      <div class={s.summary}>
        {labels?.summary ? labels.summary(start, end, totalItems) : `${start}-${end} / ${totalItems}`}
      </div>

      <div class={s.controls}>
        <div class={s.pages}>
          <button
            type="button"
            class={clsx(base.btnVariants.ghost, s.pageButton)}
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            {labels?.previous ?? 'Prev'}
          </button>

          {items.map((item, index) =>
            item === 'ellipsis' ? (
              <span key={`ellipsis-${index}`} class={s.ellipsis}>
                ...
              </span>
            ) : (
              <button
                key={item}
                type="button"
                class={clsx(
                  item === currentPage ? base.btnVariants.primary : base.btnVariants.secondary,
                  s.pageButton,
                  item === currentPage && s.pageButtonCurrent,
                )}
                onClick={() => onPageChange(item)}
                aria-current={item === currentPage ? 'page' : undefined}
              >
                {item}
              </button>
            ),
          )}

          <button
            type="button"
            class={clsx(base.btnVariants.ghost, s.pageButton)}
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            {labels?.next ?? 'Next'}
          </button>
        </div>

        {onPageSizeChange && (
          <label class={s.pageSize}>
            <span>{labels?.pageSize ?? 'Rows'}</span>
            <select
              class={clsx(base.input, s.pageSizeSelect)}
              value={String(safePageSize)}
              onChange={event => onPageSizeChange(Number((event.target as HTMLSelectElement).value))}
            >
              {pageSizeOptions.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </nav>
  );
}