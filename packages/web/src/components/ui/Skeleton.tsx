import type { CSSProperties } from 'preact';
import * as s from './Skeleton.css';

export function Skeleton({ width = '100%', height }: { width?: string | number; height?: string | number }) {
  const style: CSSProperties = { width, ...(height === undefined ? {} : { height }) };
  return <span class={s.skeleton} style={style} aria-hidden="true" />;
}

export function ContentSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div class={s.group} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={index === rows - 1 ? '62%' : '100%'} />
      ))}
    </div>
  );
}
