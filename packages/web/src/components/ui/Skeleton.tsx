import { assignInlineVars } from '@vanilla-extract/dynamic';
import { i18n } from '@/i18n';
import * as s from './Skeleton.css';

export function Skeleton({ width = '100%', height }: { width?: string | number; height?: string | number }) {
  const dimension = (value: string | number) => typeof value === 'number' ? `${value}px` : value;
  return <span class={s.skeleton} style={assignInlineVars({
    [s.skeletonWidth]: dimension(width),
    [s.skeletonHeight]: height === undefined ? '1rem' : dimension(height),
  })} aria-hidden="true" />;
}

export function ContentSkeleton({ rows = 4, label }: { rows?: number; label?: string }) {
  const rowCount = Math.max(1, Math.floor(rows));
  return (
    <div class={s.group} role="status" aria-busy="true" aria-label={label ?? i18n.t('appLoading')}>
      {Array.from({ length: rowCount }, (_, index) => (
        <Skeleton key={index} width={index === rowCount - 1 ? '62%' : '100%'} />
      ))}
    </div>
  );
}
