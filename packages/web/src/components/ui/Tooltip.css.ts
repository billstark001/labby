/** Tooltip component styles. */
import { style, keyframes } from '@vanilla-extract/css';
import { vars } from '../../styles/theme.css';

const fadeIn = keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const tooltipContent = style({
  background: vars.color.text,
  color: vars.color.surface,
  padding: `${vars.space.xs} ${vars.space.sm}`,
  borderRadius: vars.radius.sm,
  fontSize: vars.font.size.xs,
  fontWeight: vars.font.weight.medium,
  whiteSpace: 'nowrap',
  maxWidth: '260px',
  pointerEvents: 'none',
  animation: `${fadeIn} 0.15s ease`,
  boxShadow: vars.shadow.sm,
});
