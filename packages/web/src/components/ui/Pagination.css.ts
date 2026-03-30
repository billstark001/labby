import { style } from '@vanilla-extract/css';
import { breakpoints, vars } from '../../styles/theme.css.js';

export const root = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: vars.space.md,
  flexWrap: 'wrap',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      alignItems: 'stretch',
    },
  },
});

export const summary = style({
  fontSize: vars.font.size.sm,
  color: vars.color.textMuted,
  whiteSpace: 'nowrap',
});

export const controls = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.xs,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      justifyContent: 'space-between',
      width: '100%',
    },
  },
});

export const pages = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.xs,
  flexWrap: 'wrap',
});

export const pageButton = style({
  minWidth: '36px',
  justifyContent: 'center',
  paddingInline: vars.space.sm,
});

export const pageButtonCurrent = style({
  boxShadow: `0 0 0 1px ${vars.color.primary} inset`,
});

export const ellipsis = style({
  minWidth: '36px',
  textAlign: 'center',
  color: vars.color.textMuted,
  fontSize: vars.font.size.sm,
});

export const pageSize = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.xs,
  color: vars.color.textMuted,
  fontSize: vars.font.size.sm,
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      width: '100%',
      justifyContent: 'space-between',
    },
  },
});

export const pageSizeSelect = style({
  minWidth: '88px',
});