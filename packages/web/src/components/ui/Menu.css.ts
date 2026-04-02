/** Menu component styles. */
import { style } from '@vanilla-extract/css';
import { vars } from '../../styles/theme.css';

export const menuContent = style({
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  boxShadow: vars.shadow.md,
  minWidth: '160px',
  overflow: 'hidden',
  padding: `${vars.space.xs} 0`,
});

export const menuItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.sm,
  padding: `${vars.space.sm} ${vars.space.md}`,
  fontSize: vars.font.size.sm,
  color: vars.color.text,
  cursor: 'pointer',
  transition: 'background 0.1s',
  selectors: {
    '&:hover': {
      background: vars.color.background,
    },
    '&[aria-disabled="true"]': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
});

export const menuItemDanger = style([menuItem, {
  color: vars.color.danger,
}]);

export const menuSeparator = style({
  height: '1px',
  background: vars.color.border,
  margin: `${vars.space.xs} 0`,
  border: 'none',
});
