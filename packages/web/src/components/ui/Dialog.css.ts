/** Dialog component styles. */
import { style } from '@vanilla-extract/css';
import { vars } from '../../styles/theme.css.js';

export const dialogOverlay = style({
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
});

export const dialogContent = style({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: vars.color.surface,
  borderRadius: vars.radius.lg,
  padding: vars.space.xl,
  minWidth: '320px',
  width: '480px',
  maxWidth: '90vw',
  maxHeight: '80vh',
  overflow: 'auto',
  boxShadow: vars.shadow.lg,
  outline: 'none',
  zIndex: 1001,
});

export const dialogTitle = style({
  margin: `0 0 ${vars.space.sm}`,
  fontSize: vars.font.size.lg,
  fontWeight: vars.font.weight.bold,
  color: vars.color.text,
});

export const dialogDescription = style({
  margin: `0 0 ${vars.space.md}`,
  fontSize: vars.font.size.sm,
  color: vars.color.textMuted,
});

export const dialogBody = style({
  color: vars.color.text,
});

export const dialogActions = style({
  display: 'flex',
  gap: vars.space.md,
  marginTop: vars.space.lg,
  justifyContent: 'flex-end',
});
