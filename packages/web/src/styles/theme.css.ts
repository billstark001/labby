/** Design tokens / theme contract for Labby. */
import { createGlobalTheme } from '@vanilla-extract/css';

export const vars = createGlobalTheme(':root', {
  color: {
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
  },
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
});
