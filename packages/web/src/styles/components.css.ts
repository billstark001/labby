/** Shared component styles. */
import { style, styleVariants } from '@vanilla-extract/css';
import { breakpoints, vars } from './theme.css.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const appShell = style({
  display: 'flex',
  height: '100%',
  overflow: 'hidden',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      flexDirection: 'column',
    },
  },
});

export const mobileTopbar = style({
  display: 'none',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: vars.space.sm,
      padding: vars.space.sm,
      background: vars.color.surface,
      borderBottom: `1px solid ${vars.color.border}`,
    },
  },
});

export const sidebar = style({
  width: '200px',
  flexShrink: 0,
  background: vars.color.surface,
  borderRight: `1px solid ${vars.color.border}`,
  display: 'flex',
  flexDirection: 'column',
  padding: vars.space.md,
  gap: vars.space.sm,
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      width: '100%',
      borderRight: 'none',
      borderBottom: `1px solid ${vars.color.border}`,
      paddingTop: vars.space.sm,
      paddingBottom: vars.space.sm,
    },
  },
});

export const sidebarOpen = style({
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'flex',
    },
  },
});

export const sidebarClosed = style({
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'none',
    },
  },
});

export const mainContent = style({
  flex: 1,
  overflow: 'auto',
  padding: vars.space.lg,
  '@media': {
    [`(max-width: ${breakpoints.mobile})`]: {
      padding: vars.space.md,
    },
  },
});

export const sectionTitle = style({
  fontSize: vars.font.size.xl,
  fontWeight: vars.font.weight.bold,
  color: vars.color.text,
});

export const appBrand = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.xs,
  fontWeight: vars.font.weight.bold,
  fontSize: vars.font.size.lg,
  marginBottom: vars.space.md,
  color: vars.color.primary,
});

export const appBrandMobile = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: vars.space.xs,
  fontWeight: vars.font.weight.bold,
  fontSize: vars.font.size.md,
  color: vars.color.primary,
  minWidth: '100px',
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const navItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: vars.space.sm,
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderRadius: vars.radius.md,
  cursor: 'pointer',
  fontSize: vars.font.size.sm,
  fontWeight: vars.font.weight.medium,
  color: vars.color.textMuted,
  background: 'transparent',
  border: 'none',
  width: '100%',
  textAlign: 'left',
  transition: 'background 0.15s, color 0.15s',
  selectors: {
    '&:hover': {
      background: vars.color.background,
      color: vars.color.text,
    },
  },
});

export const navItemActive = style([
  navItem,
  {
    background: `${vars.color.primary}18`,
    color: vars.color.primary,
    fontWeight: vars.font.weight.bold,
  },
]);

export const navIconButton = style([
  navItem,
  {
    justifyContent: 'center',
    padding: vars.space.sm,
  },
]);

export const navMetaButton = style([
  navItem,
  {
    fontSize: vars.font.size.xs,
    color: vars.color.textMuted,
  },
]);

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export const btn = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: vars.space.xs,
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderRadius: vars.radius.md,
  fontSize: vars.font.size.sm,
  fontWeight: vars.font.weight.medium,
  transition: 'background 0.15s, opacity 0.15s',
  selectors: {
    '&:disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },
});

export const btnVariants = styleVariants({
  primary: [
    btn,
    {
      background: vars.color.primary,
      color: '#fff',
      selectors: { '&:hover:not(:disabled)': { background: vars.color.primaryHover } },
    },
  ],
  secondary: [
    btn,
    {
      background: vars.color.background,
      color: vars.color.text,
      border: `1px solid ${vars.color.border}`,
      selectors: { '&:hover:not(:disabled)': { background: vars.color.border } },
    },
  ],
  danger: [
    btn,
    {
      background: vars.color.danger,
      color: '#fff',
      selectors: { '&:hover:not(:disabled)': { opacity: 0.85 } },
    },
  ],
  ghost: [
    btn,
    {
      background: 'transparent',
      color: vars.color.textMuted,
      selectors: { '&:hover:not(:disabled)': { background: vars.color.background } },
    },
  ],
});

// ---------------------------------------------------------------------------
// Cards & surfaces
// ---------------------------------------------------------------------------

export const card = style({
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.lg,
  padding: vars.space.md,
  boxShadow: vars.shadow.sm,
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const formGroup = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.xs,
  marginBottom: vars.space.md,
});

export const label = style({
  fontSize: vars.font.size.sm,
  fontWeight: vars.font.weight.medium,
  color: vars.color.textMuted,
});

export const input = style({
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderRadius: vars.radius.md,
  border: `1px solid ${vars.color.border}`,
  fontSize: vars.font.size.sm,
  outline: 'none',
  selectors: {
    '&:focus': {
      borderColor: vars.color.primary,
      boxShadow: `0 0 0 2px ${vars.color.primary}30`,
    },
  },
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const table = style({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: vars.font.size.sm,
});

export const th = style({
  textAlign: 'left',
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderBottom: `2px solid ${vars.color.border}`,
  fontWeight: vars.font.weight.bold,
  color: vars.color.textMuted,
});

export const td = style({
  padding: `${vars.space.sm} ${vars.space.md}`,
  borderBottom: `1px solid ${vars.color.border}`,
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export const badge = style({
  display: 'inline-block',
  padding: `2px ${vars.space.sm}`,
  borderRadius: vars.radius.full,
  fontSize: vars.font.size.xs,
  fontWeight: vars.font.weight.medium,
  background: `${vars.color.accent}18`,
  color: vars.color.accent,
});

export const badgeButton = style([
  badge,
  {
    cursor: 'pointer',
    border: 'none',
  },
]);

export const badgeButtonDimmed = style({
  opacity: 0.5,
});

export const badgeSelectable = style([
  badgeButton,
  {
    opacity: 0.4,
  },
]);

export const badgeSelectableActive = style({
  opacity: 1,
});

export const historyItem = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: vars.space.xs,
});

export const historyDeleteButton = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  background: 'transparent',
  color: vars.color.textMuted,
  lineHeight: 1,
  padding: `0 ${vars.space.xs}`,
  borderRadius: vars.radius.sm,
  selectors: {
    '&:hover': {
      color: vars.color.danger,
      background: vars.color.background,
    },
  },
});

// ---------------------------------------------------------------------------
// Graph canvas
// ---------------------------------------------------------------------------

export const graphCanvas = style({
  width: '100%',
  height: '500px',
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.lg,
  overflow: 'hidden',
});

// ---------------------------------------------------------------------------
// Toolbar row
// ---------------------------------------------------------------------------

export const toolbar = style({
  display: 'flex',
  gap: vars.space.sm,
  marginBottom: vars.space.md,
  flexWrap: 'wrap',
  alignItems: 'center',
});

// ---------------------------------------------------------------------------
// Tag list
// ---------------------------------------------------------------------------

export const tagList = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: vars.space.xs,
});

// ---------------------------------------------------------------------------
// Utility styles for flex and spacing
// ---------------------------------------------------------------------------

export const flexGapXs = style({
  display: 'flex',
  gap: vars.space.xs,
});

export const flexGapSm = style({
  display: 'flex',
  gap: vars.space.sm,
});

export const flexGapMd = style({
  display: 'flex',
  gap: vars.space.md,
});

export const flexGapLg = style({
  display: 'flex',
  gap: vars.space.lg,
});

export const flexColGapSm = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.sm,
});

export const flexColGapMd = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.md,
});

// Margin utilities
export const mb4 = style({ marginBottom: '4px' });
export const mb8 = style({ marginBottom: vars.space.sm });
export const mb12 = style({ marginBottom: '12px' });
export const mb16 = style({ marginBottom: vars.space.md });
export const mb24 = style({ marginBottom: vars.space.lg });
export const mb32 = style({ marginBottom: vars.space.xl });
export const mt8 = style({ marginTop: vars.space.sm });
export const mt32 = style({ marginTop: vars.space.xl });
export const mt16 = style({ marginTop: vars.space.md });

// Padding utilities
export const p8 = style({ padding: vars.space.sm });
export const px8 = style({ paddingInline: vars.space.sm });

// Font size utilities
export const text12 = style({ fontSize: vars.font.size.xs });
export const text14 = style({ fontSize: vars.font.size.sm });
export const text15 = style({ fontSize: '15px' });
export const text16 = style({ fontSize: vars.font.size.md });
export const text18 = style({ fontSize: vars.font.size.lg });

// Font weight utilities
export const fontBold = style({ fontWeight: vars.font.weight.bold });
export const fontMedium = style({ fontWeight: vars.font.weight.medium });

// Color utilities
export const textMuted = style({ color: vars.color.textMuted });
export const textPrimary = style({ color: vars.color.primary });

// Display utilities
export const flex1 = style({ flex: 1 });
export const flexCenter = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});
export const flexBetween = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
});
export const flexWrap = style({
  display: 'flex',
  flexWrap: 'wrap',
});

export const autoWidthInput = style({
  width: 'auto',
});

export const sectionStack = style({
  marginTop: vars.space.xl,
});

export const graphLayout = style({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 320px',
  gap: vars.space.lg,
  alignItems: 'start',
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      gridTemplateColumns: '1fr',
    },
  },
});

export const graphSidebar = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.md,
});

export const metricList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.sm,
});

export const metricRow = style({
  display: 'flex',
  justifyContent: 'space-between',
  gap: vars.space.md,
  paddingBottom: vars.space.sm,
  borderBottom: `1px solid ${vars.color.border}`,
});

export const metricValue = style({
  fontVariantNumeric: 'tabular-nums',
  color: vars.color.textMuted,
});

export const toolbarTitleGroup = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.xs,
});

export const mutedParagraph = style({
  color: vars.color.textMuted,
  fontSize: vars.font.size.sm,
});

// Table cell styles (for HTML export)
export const tableCell = style({
  padding: vars.space.sm,
  border: `1px solid ${vars.color.border}`,
});

export const tableCellHeader = style([
  tableCell,
  {
    background: vars.color.background,
    fontWeight: vars.font.weight.bold,
  },
]);

// Card specific styles
export const cardNoScheduke = style([
  card,
  {
    padding: vars.space.xxl,
    textAlign: 'center',
    color: vars.color.textMuted,
  },
]);

// ---------------------------------------------------------------------------
// Graph sidebar card with max-height matching the canvas
// ---------------------------------------------------------------------------

export const graphSidebarCard = style([
  card,
  {
    maxHeight: '500px',
    overflowY: 'auto',
  },
]);

// ---------------------------------------------------------------------------
// Disabled badge
// ---------------------------------------------------------------------------

export const badgeDisabled = style({
  display: 'inline-block',
  padding: `2px ${vars.space.sm}`,
  borderRadius: vars.radius.full,
  fontSize: vars.font.size.xs,
  fontWeight: vars.font.weight.medium,
  background: `${vars.color.textMuted}28`,
  color: vars.color.textMuted,
});

// ---------------------------------------------------------------------------
// Notes cell
// ---------------------------------------------------------------------------

export const notesCell = style({
  maxWidth: '200px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: vars.font.size.xs,
});

// ---------------------------------------------------------------------------
// Danger text
// ---------------------------------------------------------------------------

export const textDanger = style({
  color: vars.color.danger,
});

// ---------------------------------------------------------------------------
// Hide on mobile
// ---------------------------------------------------------------------------

export const hideOnMobile = style({
  '@media': {
    [`(max-width: ${breakpoints.tablet})`]: {
      display: 'none',
    },
  },
});

