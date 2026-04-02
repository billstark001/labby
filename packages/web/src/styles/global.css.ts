/** Global CSS reset and base styles. */
import { globalStyle } from '@vanilla-extract/css';
import { breakpoints, vars } from './theme.css';

globalStyle('*, *::before, *::after', {
  boxSizing: 'border-box',
  margin: 0,
  padding: 0,
});

globalStyle('html, body', {
  height: '100%',
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: vars.font.size.md,
  color: vars.color.text,
  background: vars.color.background,
  transition: 'background-color 0.2s ease, color 0.2s ease',
});

// Responsive typography and spacing
globalStyle('html, body', {
  '@media': {
    [`(max-width: ${breakpoints.mobile})`]: {
      fontSize: vars.font.size.sm,
    },
    [`(min-width: ${breakpoints.tablet})`]: {
      fontSize: vars.font.size.md,
    },
  },
});

globalStyle('#app', {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
});

globalStyle('button', {
  cursor: 'pointer',
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
});

globalStyle('input, select, textarea', {
  fontFamily: 'inherit',
  fontSize: vars.font.size.sm,
});

globalStyle('a', {
  color: vars.color.primary,
  textDecoration: 'none',
});

globalStyle('h1, h2, h3, h4, h5, h6', {
  margin: '0',
});