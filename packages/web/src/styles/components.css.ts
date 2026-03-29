/** Shared component styles. */
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from './theme.css.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const appShell = style({
  display: 'flex',
  height: '100%',
  overflow: 'hidden',
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
});

export const mainContent = style({
  flex: 1,
  overflow: 'auto',
  padding: vars.space.lg,
});

export const sectionTitle = style({
  fontSize: vars.font.size.xl,
  fontWeight: vars.font.weight.bold,
  marginBottom: vars.space.md,
  color: vars.color.text,
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

// ---------------------------------------------------------------------------
// Modal overlay
// ---------------------------------------------------------------------------

export const modalOverlay = style({
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
});

export const modalBox = style({
  background: vars.color.surface,
  borderRadius: vars.radius.lg,
  padding: vars.space.xl,
  width: '480px',
  maxWidth: '90vw',
  maxHeight: '80vh',
  overflow: 'auto',
  boxShadow: vars.shadow.lg,
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
