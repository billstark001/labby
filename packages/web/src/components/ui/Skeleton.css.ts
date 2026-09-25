import { createVar, keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../styles/theme.css';

const pulse = keyframes({
  '0%, 100%': { opacity: 0.5 },
  '50%': { opacity: 1 },
});

export const skeletonWidth = createVar();
export const skeletonHeight = createVar();
export const skeleton = style({
  display: 'block',
  width: skeletonWidth,
  height: skeletonHeight,
  borderRadius: vars.radius.sm,
  background: vars.color.border,
  animation: `${pulse} 1.5s ease-in-out infinite`,
  '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
});

export const group = style({ display: 'grid', gap: vars.space.sm, width: '100%' });
