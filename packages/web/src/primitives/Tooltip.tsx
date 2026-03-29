/**
 * Tooltip — headless tooltip primitive.
 *
 * Usage:
 *   <Tooltip content="Helpful hint">
 *     <button>Hover me</button>
 *   </Tooltip>
 */
import { type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { CSSProperties } from 'preact';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  children: ComponentChildren;
  side?: Side;
}

const sideStyle: Record<Side, CSSProperties> = {
  top:    { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  bottom: { top: 'calc(100% + 6px)',    left: '50%', transform: 'translateX(-50%)' },
  left:   { right: 'calc(100% + 6px)', top: '50%',  transform: 'translateY(-50%)' },
  right:  { left:  'calc(100% + 6px)', top: '50%',  transform: 'translateY(-50%)' },
};

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            ...sideStyle[side],
            pointerEvents: 'none',
            zIndex: 800,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
