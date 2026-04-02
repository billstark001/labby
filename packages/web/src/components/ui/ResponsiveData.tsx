import { type ComponentChildren, type JSX } from 'preact';
import clsx from 'clsx';
import * as base from '../../styles/components.css';
import * as s from './ResponsiveData.css';

type RowKey = string | number;

export interface ResponsiveDataColumn {
  header: ComponentChildren;
  className?: string;
  headerClassName?: string;
}

interface ResponsiveDataViewProps<T> {
  items: readonly T[];
  columns: readonly ResponsiveDataColumn[];
  getKey: (item: T, index: number) => RowKey;
  renderDesktopRow: (item: T, index: number) => ComponentChildren;
  renderMobileCard: (item: T, index: number) => ComponentChildren;
  renderActions?: (item: T, index: number) => ComponentChildren;
  getDesktopRowProps?: (item: T, index: number) => JSX.HTMLAttributes<HTMLTableRowElement> | undefined;
  getMobileCardProps?: (item: T, index: number) => JSX.HTMLAttributes<HTMLDivElement> | undefined;
  colGroup?: ComponentChildren;
  empty?: ComponentChildren;
  class?: string;
  desktopTableClass?: string;
  mobileListClass?: string;
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
}: ResponsiveDataViewProps<T>) {
  if (items.length === 0) {
    return <div class={clsx(s.empty, className)}>{empty ?? '—'}</div>;
  }

  return (
    <div class={clsx(s.root, className)}>
      <div class={s.desktopViewport}>
        <table class={clsx(base.table, s.desktopTable, desktopTableClass)}>
          {colGroup}
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} class={clsx(base.th, column.headerClassName, column.className)}>
                  {column.header}
                </th>
              ))}
              {renderActions && (
                <th class={base.th}>{/* Actions column */}</th>
              )}
            </tr>
          </thead>
          <tbody>
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
        {items.map((item, index) => {
          const cardProps = getMobileCardProps?.(item, index) ?? {};
          const { class: cardClassName, ...cardRest } = cardProps;
          return (
            <div key={getKey(item, index)} class={clsx(s.mobileCard, cardClassName)} {...cardRest}>
              {renderMobileCard(item, index)}
              {renderActions && (
                <div class={base.flexGapXs}>{renderActions(item, index)}</div>
              )}
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