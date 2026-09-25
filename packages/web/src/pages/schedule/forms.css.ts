import { globalStyle, style } from '@vanilla-extract/css';
import { breakpoints, vars } from '@/styles/theme.css';

export const configForm = style({ width: '100%', minWidth: 0 });
export const section = style({
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  padding: vars.space.md,
  marginBottom: vars.space.md,
  minWidth: 0,
});
export const sectionTitle = style({
  margin: `0 0 ${vars.space.md}`,
  fontSize: vars.font.size.md,
  fontWeight: vars.font.weight.bold,
});
export const grid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: vars.space.md,
  minWidth: 0,
  '@media': { [`(max-width: ${breakpoints.tablet})`]: { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
export const full = style({ gridColumn: '1 / -1', minWidth: 0 });
export const gapFieldset = style({ border: 0, minWidth: 0, padding: 0, margin: 0 });
export const gapSummary = style({ cursor: 'pointer' });
export const gapLegend = style({ marginBottom: '0.5rem' });
export const tuningDetails = style({
  borderTop: `1px solid ${vars.color.border}`,
  paddingTop: vars.space.sm,
});
globalStyle(`${tuningDetails} > summary`, { cursor: 'pointer', fontWeight: vars.font.weight.bold });
export const weightControl = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.sm,
  minWidth: 0,
});
globalStyle(`${weightControl} > input`, { flex: '1 1 0', minWidth: 0 });
