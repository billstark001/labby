/**
 * Accordion — headless accordion primitive, close to the Radix UI API.
 *
 * Usage:
 *   <Accordion type="single" collapsible>
 *     <AccordionItem value="a">
 *       <AccordionTrigger>Section A</AccordionTrigger>
 *       <AccordionContent>Content A</AccordionContent>
 *     </AccordionItem>
 *   </Accordion>
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';

interface AccordionContextValue {
  openValues: Signal<string[]>;
  toggle: (value: string) => void;
}

interface ItemContextValue {
  value: string;
  isOpen: () => boolean;
  toggle: (value: string) => void;
}

const AccordionCtx = createContext<AccordionContextValue | null>(null);
const ItemCtx = createContext<ItemContextValue | null>(null);

interface AccordionProps {
  children: ComponentChildren;
  type?: 'single' | 'multiple';
  collapsible?: boolean;
}

export function Accordion({ children, type = 'single', collapsible = true }: AccordionProps) {
  const openValues = signal<string[]>([]);

  function toggle(value: string) {
    if (type === 'single') {
      const already = openValues.value.includes(value);
      openValues.value = (already && collapsible) ? [] : [value];
    } else {
      const already = openValues.value.includes(value);
      openValues.value = already
        ? openValues.value.filter(v => v !== value)
        : [...openValues.value, value];
    }
  }

  return (
    <AccordionCtx.Provider value={{ openValues, toggle }}>
      <div>{children}</div>
    </AccordionCtx.Provider>
  );
}

export function AccordionItem({ value, children }: { value: string; children: ComponentChildren }) {
  const { openValues, toggle } = useContext(AccordionCtx)!;
  const isOpen = () => openValues.value.includes(value);
  return (
    <ItemCtx.Provider value={{ value, isOpen, toggle }}>
      <div>{children}</div>
    </ItemCtx.Provider>
  );
}

export function AccordionTrigger({ children }: { children: ComponentChildren }) {
  const { value, isOpen, toggle } = useContext(ItemCtx)!;
  const open = isOpen();
  return (
    <button
      aria-expanded={open}
      onClick={() => toggle(value)}
    >
      {children}
      <span aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

export function AccordionContent({ children }: { children: ComponentChildren }) {
  const { isOpen } = useContext(ItemCtx)!;
  if (!isOpen()) return null;
  return <div>{children}</div>;
}
