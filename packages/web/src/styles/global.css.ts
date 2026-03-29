/** Global CSS reset and base styles. */
import { globalStyle } from '@vanilla-extract/css';
import { vars } from './theme.css.js';

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
