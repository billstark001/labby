/**
 * Menu — business-layer wrapper providing styled dropdown and context menus.
 *
 * Usage – dropdown:
 *   <Menu>
 *     <MenuTrigger><Button>Open</Button></MenuTrigger>
 *     <MenuContent>
 *       <MenuItem onSelect={() => void 0}>Action</MenuItem>
 *     </MenuContent>
 *   </Menu>
 *
 * Usage – context menu:
 *   <Menu mode="context">
 *     <MenuTrigger><div>Right-click me</div></MenuTrigger>
 *     <MenuContent>
 *       <MenuItem onSelect={() => void 0}>Action</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
import { type ComponentChildren } from 'preact';
import {
  Menu as PrimitiveMenu,
  MenuTrigger as PrimitiveTrigger,
  MenuContent as PrimitiveContent,
  MenuItem as PrimitiveItem,
  MenuSeparator as PrimitiveSeparator,
  type MenuMode,
} from '../../primitives/Menu.js';
import * as css from './Menu.css.js';

export type { MenuMode };

export function Menu({ children, mode }: { children: ComponentChildren; mode?: MenuMode }) {
  return <PrimitiveMenu mode={mode}>{children}</PrimitiveMenu>;
}

export function MenuTrigger({ children }: { children: ComponentChildren }) {
  return <PrimitiveTrigger>{children}</PrimitiveTrigger>;
}

interface MenuContentProps {
  children: ComponentChildren;
  align?: 'start' | 'end';
}
export function MenuContent({ children, align }: MenuContentProps) {
  return (
    <PrimitiveContent align={align}>
      <div class={css.menuContent}>{children}</div>
    </PrimitiveContent>
  );
}

interface MenuItemProps {
  children: ComponentChildren;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}
export function MenuItem({ children, onSelect, disabled, danger }: MenuItemProps) {
  return (
    <PrimitiveItem onSelect={onSelect} disabled={disabled}>
      <div class={danger ? css.menuItemDanger : css.menuItem}>{children}</div>
    </PrimitiveItem>
  );
}

export function MenuSeparator() {
  return (
    <PrimitiveSeparator />
  );
}
