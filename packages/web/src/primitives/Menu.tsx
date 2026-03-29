/**
 * Menu — unified menu primitive supporting both dropdown and context-menu modes.
 *
 * mode="dropdown" (default): renders a trigger + popover below/above it.
 * mode="context": no visible trigger; the popover opens at the pointer position
 *   on right-click of the designated trigger area.
 *
 * Usage – dropdown:
 *   <Menu>
 *     <MenuTrigger><button>Open</button></MenuTrigger>
 *     <MenuContent>
 *       <MenuItem onSelect={() => doSomething()}>Action</MenuItem>
 *       <MenuSeparator />
 *     </MenuContent>
 *   </Menu>
 *
 * Usage – context:
 *   <Menu mode="context">
 *     <MenuTrigger><div>Right-click me</div></MenuTrigger>
 *     <MenuContent>
 *       <MenuItem onSelect={() => doSomething()}>Action</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';

export type MenuMode = 'dropdown' | 'context';

interface MenuPosition {
  x: number;
  y: number;
}

interface MenuContextValue {
  open: Signal<boolean>;
  position: Signal<MenuPosition>;
  mode: MenuMode;
  close: () => void;
}

const MenuCtx = createContext<MenuContextValue | null>(null);

interface MenuProps {
  children: ComponentChildren;
  mode?: MenuMode;
}

export function Menu({ children, mode = 'dropdown' }: MenuProps) {
  const open = signal(false);
  const position = signal<MenuPosition>({ x: 0, y: 0 });
  const close = () => { open.value = false; };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-menu-root]')) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <MenuCtx.Provider value={{ open, position, mode, close }}>
      <div data-menu-root style={{ position: 'relative', display: 'inline-block' }}>
        {children}
      </div>
    </MenuCtx.Provider>
  );
}

interface MenuTriggerProps {
  children: ComponentChildren;
}

export function MenuTrigger({ children }: MenuTriggerProps) {
  const ctx = useContext(MenuCtx)!;

  if (ctx.mode === 'context') {
    return (
      <div
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          ctx.position.value = { x: e.clientX, y: e.clientY };
          ctx.open.value = true;
        }}
      >
        {children}
      </div>
    );
  }

  // dropdown mode
  const toggle = () => { ctx.open.value = !ctx.open.value; };
  return (
    <div
      onClick={toggle}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
    >
      {children}
    </div>
  );
}

interface MenuContentProps {
  children: ComponentChildren;
  align?: 'start' | 'end';
}

export function MenuContent({ children, align = 'start' }: MenuContentProps) {
  const ctx = useContext(MenuCtx)!;
  if (!ctx.open.value) return null;

  if (ctx.mode === 'context') {
    const { x, y } = ctx.position.value;
    return (
      <div
        role="menu"
        style={{
          position: 'fixed',
          top: y,
          left: x,
          zIndex: 9000,
        }}
      >
        {children}
      </div>
    );
  }

  const alignStyle = align === 'end' ? { right: 0 as const } : { left: 0 as const };
  return (
    <div
      role="menu"
      style={{
        position: 'absolute',
        top: '100%',
        ...alignStyle,
        zIndex: 9000,
      }}
    >
      {children}
    </div>
  );
}

interface MenuItemProps {
  children: ComponentChildren;
  onSelect?: () => void;
  disabled?: boolean;
}

export function MenuItem({ children, onSelect, disabled }: MenuItemProps) {
  const { close } = useContext(MenuCtx)!;
  const handleSelect = () => {
    if (disabled) return;
    onSelect?.();
    close();
  };
  return (
    <div
      role="menuitem"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handleSelect}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(); }}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <hr />;
}

// ---------------------------------------------------------------------------
// Keep old names for backwards compatibility
// ---------------------------------------------------------------------------
export { Menu as DropdownMenu };
export { MenuTrigger as DropdownTrigger };
export { MenuContent as DropdownContent };
export { MenuItem as DropdownItem };
export { MenuSeparator as DropdownSeparator };
