import { globalStyle, style } from '@vanilla-extract/css';
import { breakpoints, vars } from '@/styles/theme.css';
import * as s from '@/styles/components.css';

export const form = style({ display: 'flex', flexDirection: 'column', gap: vars.space.md, minWidth: 0 });
globalStyle(`${form} > .${s.formGroup}`, { marginBottom: 0 });
export const groupList = style({ display: 'grid', gap: vars.space.md });
export const groupCard = style({
  minWidth: 0,
  padding: vars.space.md,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.lg,
  background: vars.color.background,
  '@media': { [`(max-width: ${breakpoints.mobile})`]: { padding: vars.space.sm } },
});
export const groupHeader = style({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  flexWrap: 'wrap', gap: vars.space.sm, marginBottom: vars.space.md,
});
export const groupTitle = style({ margin: 0, fontSize: vars.font.size.md, fontWeight: vars.font.weight.bold });
export const groupPicker = style({
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: vars.space.md, minWidth: 0,
  '@media': { [`(max-width: ${breakpoints.mobile})`]: { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle(`${groupPicker} > .${s.formGroup}`, { minWidth: 0, marginBottom: 0 });
globalStyle(`${groupPicker} .${s.tagList}`, { alignContent: 'flex-start', minHeight: '2rem' });
globalStyle(`${groupPicker} .${s.badgeSelectable}`, { opacity: 0.75, padding: `4px ${vars.space.sm}` });
globalStyle(`${groupPicker} .${s.badgeSelectableActive}`, { opacity: 1 });

export const addGroup = style({ alignSelf: 'flex-start' });
export const ruleOptions = style({
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: vars.space.md,
  '@media': { [`(max-width: ${breakpoints.mobile})`]: { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
globalStyle(`${ruleOptions} > .${s.formGroup}`, { minWidth: 0, marginBottom: 0 });
export const multiplierHelp = style({ margin: 0, color: vars.color.textMuted, fontSize: vars.font.size.sm, lineHeight: 1.5 });
export const preview = style({
  padding: vars.space.md, border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.lg, minWidth: 0,
});
export const previewTitle = style({ margin: `0 0 ${vars.space.xs}`, fontWeight: vars.font.weight.bold });
export const previewCount = style({ margin: `0 0 ${vars.space.sm}`, color: vars.color.textMuted, fontSize: vars.font.size.sm });
export const actions = style({ display: 'flex', flexWrap: 'wrap', gap: vars.space.sm, paddingTop: vars.space.sm });

export const targetSummary = style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: vars.space.xs, minWidth: 0 });
export const targetGroup = style({ display: 'flex', alignItems: 'flex-start', gap: vars.space.xs, minWidth: 0, maxWidth: '100%' });
export const targetGroupLabel = style({ flex: '0 0 auto', color: vars.color.textMuted, fontSize: vars.font.size.xs, lineHeight: '22px' });
export const targetMembers = style({ display: 'flex', flexWrap: 'wrap', gap: vars.space.xs, minWidth: 0, overflowWrap: 'anywhere' });
