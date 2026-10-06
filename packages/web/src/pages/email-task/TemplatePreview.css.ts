import { style } from '@vanilla-extract/css';
import { vars } from '@/styles/theme.css';

export const warning = style({
  position: 'sticky', top: 8, zIndex: 2,
  border: `1px solid ${vars.color.warning}`, borderLeftWidth: 4,
  background: vars.color.surface, color: vars.color.text,
  padding: 16, marginBottom: 16, borderRadius: 8,
  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
});
export const errorList = style({
  maxHeight: '25vh', overflow: 'auto', overflowWrap: 'anywhere',
  margin: '8px 0 0', paddingLeft: 20,
});
