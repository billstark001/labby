/** Design tokens / theme contract for Labby. */
import { createGlobalTheme } from '@vanilla-extract/css';

export const breakpoints = {
  mobile: '640px',
  tablet: '1024px',
  desktop: '1440px',
} as const;

// Light theme colors
const lightColors = {
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  secondary: '#64748b',
  background: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  text: '#0f172a',
  textMuted: '#64748b',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  accent: '#7c3aed',
};

// Dark theme colors
const darkColors = {
  primary: '#3b82f6',
  primaryHover: '#60a5fa',
  secondary: '#94a3b8',
  background: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  text: '#f1f5f9',
  textMuted: '#94a3b8',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  accent: '#a78bfa',
};

// Shared tokens
const sharedTokens = {
  space: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },
  radius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    full: '9999px',
  },
  font: {
    size: {
      xs: '12px',
      sm: '14px',
      md: '16px',
      lg: '18px',
      xl: '20px',
      xxl: '24px',
    },
    weight: {
      normal: '400',
      medium: '500',
      bold: '700',
    },
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.08)',
    md: '0 4px 12px rgba(0,0,0,0.12)',
    lg: '0 8px 24px rgba(0,0,0,0.15)',
  },
};

export const vars = createGlobalTheme(':root', {
  color: lightColors,
  ...sharedTokens,
});

// Dark mode theme override
import { globalStyle } from '@vanilla-extract/css';

globalStyle(':root.theme-dark', {
  colorScheme: 'dark',
  vars: {
    [vars.color.primary]: darkColors.primary,
    [vars.color.primaryHover]: darkColors.primaryHover,
    [vars.color.secondary]: darkColors.secondary,
    [vars.color.background]: darkColors.background,
    [vars.color.surface]: darkColors.surface,
    [vars.color.border]: darkColors.border,
    [vars.color.text]: darkColors.text,
    [vars.color.textMuted]: darkColors.textMuted,
    [vars.color.success]: darkColors.success,
    [vars.color.warning]: darkColors.warning,
    [vars.color.danger]: darkColors.danger,
    [vars.color.accent]: darkColors.accent,
  },
});

globalStyle(':root.theme-light', {
  colorScheme: 'light',
});

// Prefer color scheme media query fallback
globalStyle(':root:not(.theme-light):not(.theme-dark)', {
  '@media': {
    '(prefers-color-scheme: dark)': {
      colorScheme: 'dark',
      vars: {
        [vars.color.primary]: darkColors.primary,
        [vars.color.primaryHover]: darkColors.primaryHover,
        [vars.color.secondary]: darkColors.secondary,
        [vars.color.background]: darkColors.background,
        [vars.color.surface]: darkColors.surface,
        [vars.color.border]: darkColors.border,
        [vars.color.text]: darkColors.text,
        [vars.color.textMuted]: darkColors.textMuted,
        [vars.color.success]: darkColors.success,
        [vars.color.warning]: darkColors.warning,
        [vars.color.danger]: darkColors.danger,
        [vars.color.accent]: darkColors.accent,
      },
    },
  },
});

