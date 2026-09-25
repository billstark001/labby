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
import { useContext, useEffect, useMemo, useRef } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import * as css from './primitives.css';

export type MenuMode = 'dropdown' | 'context';

interface MenuPosition {
  x: number;
  y: number;
}

interface MenuContextValue {
  open: Signal<boolean>;
  position: Signal<MenuPosition>;
  mode: MenuMode;
  show: () => void;
  close: () => void;
}

const MenuCtx = createContext<MenuContextValue | null>(null);

interface MenuProps {
  children: ComponentChildren;
  mode?: MenuMode;
}

export function Menu({ children, mode = 'dropdown' }: MenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useRef(Symbol('menu'));
  const open = useMemo(() => signal(false), []);
  const position = useMemo(() => signal<MenuPosition>({ x: 0, y: 0 }), []);
  const close = () => { open.value = false; };
  const show = () => {
    document.dispatchEvent(new CustomEvent('labby-menu-open', { detail: menuId.current }));
    open.value = true;
  };

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      const target = e.target;
      if (!root || !(target instanceof Node)) return;
      if (!root.contains(target)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onOtherMenuOpen = (event: Event) => {
      if ((event as CustomEvent).detail !== menuId.current) close();
    };
    const onViewportChange = () => close();

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('labby-menu-open', onOtherMenuOpen);
    window.addEventListener('blur', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('labby-menu-open', onOtherMenuOpen);
      window.removeEventListener('blur', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, []);

  return (
    <MenuCtx.Provider value={{ open, position, mode, show, close }}>
      <div ref={rootRef} data-menu-root class={css.root}>
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
          ctx.show();
        }}
      >
        {children}
      </div>
    );
  }

  // dropdown mode
  const toggle = () => { ctx.open.value ? ctx.close() : ctx.show(); };
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
        onClick={(event: MouseEvent) => event.stopPropagation()}
        onContextMenu={(event: MouseEvent) => event.stopPropagation()}
        class={css.contextMenu}
        style={assignInlineVars({ [css.menuPositionX]: `${x}px`, [css.menuPositionY]: `${y}px` })}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      role="menu"
      onClick={(event: MouseEvent) => event.stopPropagation()}
      onContextMenu={(event: MouseEvent) => event.stopPropagation()}
      class={`${css.dropdownMenu} ${css.align[align]}`}
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
      class={disabled ? css.disabledItem : undefined}
    >
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <hr />;
}
