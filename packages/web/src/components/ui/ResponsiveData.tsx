import { type ComponentChildren, type JSX } from 'preact';
import clsx from 'clsx';
import * as base from '../../styles/components.css';
import * as s from './ResponsiveData.css';
import { i18n } from '@/i18n';
import type { ListSortDirection } from '@labby/core';

type RowKey = string | number;

export interface ResponsiveDataColumn {
  header: ComponentChildren;
  className?: string;
  headerClassName?: string;
  sortKey?: string;
}

export interface DataSorting {
  key: string;
  direction: ListSortDirection;
  options: readonly { key: string; label: string; defaultDirection?: ListSortDirection }[];
  onChange: (key: string, direction: ListSortDirection) => void;
}

interface ResponsiveDataViewProps<T> {
  items: readonly T[];
  columns: readonly ResponsiveDataColumn[];
  getKey: (item: T, index: number) => RowKey;
  renderDesktopRow: (item: T, index: number) => ComponentChildren;
  renderMobileCard: (item: T, index: number) => ComponentChildren;
  renderActions?: (item: T, index: number) => ComponentChildren;
  getDesktopRowProps?: (
    item: T,
    index: number,
  ) => JSX.HTMLAttributes<HTMLTableRowElement> | undefined;
  getMobileCardProps?: (item: T, index: number) => JSX.HTMLAttributes<HTMLDivElement> | undefined;
  colGroup?: ComponentChildren;
  empty?: ComponentChildren;
  class?: string;
  desktopTableClass?: string;
  mobileListClass?: string;
  sorting?: DataSorting;
}

export function ResponsiveDataView<T>({
  items,
  columns,
  getKey,
  renderDesktopRow,
  renderMobileCard,
  renderActions,
  getDesktopRowProps,
  getMobileCardProps,
  colGroup,
  empty,
  class: className,
  desktopTableClass,
  mobileListClass,
  sorting,
}: ResponsiveDataViewProps<T>) {
  const { t } = i18n;
  function selectSort(key: string) {
    const option = sorting?.options.find((option) => option.key === key);
    if (!sorting || !option) return;
    sorting.onChange(
      key,
      sorting.key === key
        ? sorting.direction === 'asc'
          ? 'desc'
          : 'asc'
        : (option.defaultDirection ?? 'asc'),
    );
  }

  return (
    <div class={clsx(s.root, className)}>
      {sorting && (
        <div class={s.mobileSort}>
          <label>
            {t('sortByLabel')}
            <select
              class={base.input}
              value={sorting.key}
              onChange={(event) => {
                const key = event.currentTarget.value;
                sorting.onChange(
                  key,
                  sorting.options.find((option) => option.key === key)?.defaultDirection ?? 'asc',
                );
              }}
            >
              {sorting.options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('sortDirectionLabel')}
            <select
              class={base.input}
              value={sorting.direction}
              onChange={(event) =>
                sorting.onChange(sorting.key, event.currentTarget.value as ListSortDirection)
              }
            >
              <option value="asc">{t('sortAscending')}</option>
              <option value="desc">{t('sortDescending')}</option>
            </select>
          </label>
        </div>
      )}
      <div class={s.desktopViewport}>
        <table class={clsx(base.table, s.desktopTable, desktopTableClass)}>
          {colGroup}
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={index}
                  class={clsx(base.th, column.headerClassName, column.className)}
                  aria-sort={
                    column.sortKey && sorting?.key === column.sortKey
                      ? sorting.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  {column.sortKey &&
                  sorting?.options.some((option) => option.key === column.sortKey) ? (
                    <button
                      type="button"
                      class={s.sortHeader}
                      onClick={() => selectSort(column.sortKey!)}
                    >
                      {column.header}
                      <span aria-hidden="true">
                        {sorting.key === column.sortKey
                          ? sorting.direction === 'asc'
                            ? ' ↑'
                            : ' ↓'
                          : ' ↕'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
              {renderActions && <th class={base.th}>{/* Actions column */}</th>}
            </tr>
          </thead>
          <tbody>
            {!items.length && (
              <tr>
                <td class={s.empty} colSpan={columns.length + (renderActions ? 1 : 0)}>
                  {empty ?? '—'}
                </td>
              </tr>
            )}
            {items.map((item, index) => {
              const rowProps = getDesktopRowProps?.(item, index) ?? {};
              const { class: rowClassName, ...rowRest } = rowProps;
              return (
                <tr key={getKey(item, index)} class={rowClassName} {...rowRest}>
                  {renderDesktopRow(item, index)}
                  {renderActions && (
                    <td class={base.td}>
                      <div class={base.flexGapXs}>{renderActions(item, index)}</div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div class={clsx(s.mobileList, mobileListClass)}>
        {!items.length && <div class={s.empty}>{empty ?? '—'}</div>}
        {items.map((item, index) => {
          const cardProps = getMobileCardProps?.(item, index) ?? {};
          const { class: cardClassName, ...cardRest } = cardProps;
          return (
            <div key={getKey(item, index)} class={clsx(s.mobileCard, cardClassName)} {...cardRest}>
              {renderMobileCard(item, index)}
              {renderActions && <div class={base.flexGapXs}>{renderActions(item, index)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ResponsiveDataFieldProps {
  label: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  valueClass?: string;
}

export function ResponsiveDataField({
  label,
  children,
  class: className,
  valueClass,
}: ResponsiveDataFieldProps) {
  return (
    <div class={clsx(s.field, className)}>
      <div class={s.fieldLabel}>{label}</div>
      <div class={clsx(s.fieldValue, valueClass)}>{children}</div>
    </div>
  );
}

export const responsiveDataStyles = s;
