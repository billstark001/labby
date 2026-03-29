/** Toast component styles. */
import { style, keyframes } from '@vanilla-extract/css';
import { vars } from '../../styles/theme.css.js';

const slideIn = keyframes({
  from: { transform: 'translateX(100%)', opacity: 0 },
  to: { transform: 'translateX(0)', opacity: 1 },
});

export const toastContainer = style({
  position: 'fixed',
  bottom: vars.space.lg,
  right: vars.space.lg,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.sm,
  pointerEvents: 'none',
});

export const toastItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.sm,
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderRadius: vars.radius.md,
  fontSize: vars.font.size.sm,
  fontWeight: vars.font.weight.medium,
  boxShadow: vars.shadow.md,
  animation: `${slideIn} 0.2s ease`,
  pointerEvents: 'auto',
  cursor: 'pointer',
  minWidth: '220px',
  maxWidth: '360px',
  userSelect: 'none',
});

export const toastVariants = {
  success: style([toastItem, { background: vars.color.success, color: '#fff' }]),
  error:   style([toastItem, { background: vars.color.danger,  color: '#fff' }]),
  info:    style([toastItem, { background: vars.color.primary, color: '#fff' }]),
  warning: style([toastItem, { background: vars.color.warning, color: '#fff' }]),
  loading: style([toastItem, { background: vars.color.surface, color: vars.color.text, border: `1px solid ${vars.color.border}` }]),
} as const;

export const toastMessage = style({ flex: 1 });
export const toastClose = style({ opacity: 0.8, flexShrink: 0 });
