import { createVar, style, styleVariants } from '@vanilla-extract/css';

export const root = style({ position: 'relative', display: 'inline-block' });
export const menuPositionX = createVar();
export const menuPositionY = createVar();
export const contextMenu = style({ position: 'fixed', top: menuPositionY, left: menuPositionX, zIndex: 9000 });
export const dropdownMenu = style({ position: 'absolute', top: '100%', zIndex: 9000 });
export const dropdownContent = style({ position: 'absolute', top: '100%', zIndex: 500 });
export const align = styleVariants({ start: { left: 0 }, end: { right: 0 } });
export const disabledItem = style({ opacity: 0.5 });

export const tooltipRoot = style({ position: 'relative', display: 'inline-flex' });
export const tooltipContent = style({ position: 'absolute', pointerEvents: 'none', zIndex: 800 });
export const tooltipSide = styleVariants({
  top: { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  bottom: { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  left: { right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
  right: { left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
});

export const toastEntry = style({ cursor: 'pointer' });
export const toaster = style({ position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999 });
