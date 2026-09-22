import type { CSSProperties } from 'preact';
import { i18n } from '@/i18n';
import * as s from './Skeleton.css';

export function Skeleton({ width = '100%', height }: { width?: string | number; height?: string | number }) {
  const style: CSSProperties = { width, ...(height === undefined ? {} : { height }) };
  return <span class={s.skeleton} style={style} aria-hidden="true" />;
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
