/** Dialog component styles. */
import { style } from '@vanilla-extract/css';
import { breakpoints, vars } from '../../styles/theme.css';

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
  padding: 0,
  minWidth: '320px',
  maxWidth: '90vw',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: vars.shadow.lg,
  outline: 'none',
  zIndex: 1001,
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      minWidth: 'min(320px, 92vw)',
    },
  },
});

export const dialogTitle = style({
  margin: 0,
  minWidth: 0,
  fontSize: vars.font.size.lg,
  fontWeight: vars.font.weight.bold,
  overflowWrap: 'anywhere',
  color: vars.color.text,
});

export const dialogHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: vars.space.md,
  minHeight: '56px',
  padding: `${vars.space.md} ${vars.space.lg}`,
  borderBottom: `1px solid ${vars.color.border}`,
  flex: '0 0 auto',
});

export const dialogClose = style({
  display: 'grid',
  placeItems: 'center',
  flex: '0 0 auto',
  width: '36px',
  height: '36px',
  margin: '-8px',
  border: 0,
  borderRadius: vars.radius.md,
  color: vars.color.textMuted,
  background: 'transparent',
  cursor: 'pointer',
  selectors: {
    '&:hover': { color: vars.color.text, background: vars.color.background },
    '&:focus-visible': { outline: `2px solid ${vars.color.primary}`, outlineOffset: '2px' },
  },
});

export const dialogDescription = style({
  margin: `0 0 ${vars.space.md}`,
  fontSize: vars.font.size.sm,
  color: vars.color.textMuted,
});

export const dialogBody = style({
  color: vars.color.text,
  padding: `${vars.space.lg} ${vars.space.lg}`,
  minHeight: 0,
  overflowY: 'auto',
});

export const dialogActions = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: vars.space.md,
  padding: `${vars.space.md} ${vars.space.lg}`,
  justifyContent: 'flex-end',
  borderTop: `1px solid ${vars.color.border}`,
  flex: '0 0 auto',
});
