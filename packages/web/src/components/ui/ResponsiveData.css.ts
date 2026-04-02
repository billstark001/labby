import { style } from '@vanilla-extract/css';
import { breakpoints, vars } from '../../styles/theme.css';
import { card } from '../../styles/components.css';

export const root = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.md,
});

export const desktopViewport = style({
  width: '100%',
  overflowX: 'auto',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'none',
    },
  },
});

export const desktopTable = style({
  minWidth: '100%',
});

export const mobileList = style({
  display: 'none',
  gap: vars.space.sm,
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'flex',
      flexDirection: 'column',
    },
  },
});

export const mobileCard = style([
  card,
  {
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.md,
    padding: vars.space.md,
    boxShadow: 'none',
  },
]);

export const mobileHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: vars.space.md,
});

export const mobileTitle = style({
  fontSize: vars.font.size.sm,
  fontWeight: vars.font.weight.bold,
  color: vars.color.text,
});

export const mobileSubtitle = style({
  fontSize: vars.font.size.xs,
  color: vars.color.textMuted,
});

export const mobileFields = style({
  display: 'grid',
  gap: vars.space.sm,
});

export const field = style({
  display: 'grid',
  gap: vars.space.xs,
  minWidth: 0,
});

export const fieldLabel = style({
  fontSize: vars.font.size.xs,
  fontWeight: vars.font.weight.medium,
  color: vars.color.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
});

export const fieldValue = style({
  minWidth: 0,
  color: vars.color.text,
});

export const empty = style([
  card,
  {
    color: vars.color.textMuted,
    textAlign: 'center',
    boxShadow: 'none',
  },
]);