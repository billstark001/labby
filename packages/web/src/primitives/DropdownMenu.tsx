/**
 * DropdownMenu — headless dropdown primitive, close to the Radix UI API.
 *
 * Usage:
 *   <DropdownMenu>
 *     <DropdownTrigger><button>Open</button></DropdownTrigger>
 *     <DropdownContent>
 *       <DropdownItem onSelect={() => doSomething()}>Action</DropdownItem>
 *       <DropdownSeparator />
 *       <DropdownItem onSelect={() => doOther()} disabled>Disabled</DropdownItem>
 *     </DropdownContent>
 *   </DropdownMenu>
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import * as css from './primitives.css';

interface DropdownContextValue {
  open: Signal<boolean>;
  close: () => void;
}

const DropdownCtx = createContext<DropdownContextValue | null>(null);

export function DropdownMenu({ children }: { children: ComponentChildren }) {
  const open = signal(false);
  const close = () => { open.value = false; };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-dropdown-root]')) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <DropdownCtx.Provider value={{ open, close }}>
      <div data-dropdown-root class={css.root}>
        {children}
      </div>
    </DropdownCtx.Provider>
  );
}

export function DropdownTrigger({ children }: { children: ComponentChildren }) {
  const { open } = useContext(DropdownCtx)!;
  const toggle = () => { open.value = !open.value; };
  return (
    <div
      onClick={toggle}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
    >
      {children}
    </div>
  );
}

interface DropdownContentProps {
  children: ComponentChildren;
  align?: 'start' | 'end';
}

export function DropdownContent({ children, align = 'start' }: DropdownContentProps) {
  const { open } = useContext(DropdownCtx)!;
  if (!open.value) return null;

  return (
    <div
      role="menu"
      class={`${css.dropdownContent} ${css.align[align]}`}
    >
      {children}
    </div>
  );
}

interface DropdownItemProps {
  children: ComponentChildren;
  onSelect?: () => void;
  disabled?: boolean;
}

export function DropdownItem({ children, onSelect, disabled }: DropdownItemProps) {
  const { close } = useContext(DropdownCtx)!;
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

export function DropdownSeparator() {
  return <hr />;
}
