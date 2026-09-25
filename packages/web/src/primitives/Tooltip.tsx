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
import * as css from './primitives.css';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  children: ComponentChildren;
  side?: Side;
  /** Optional custom render function for the tooltip content. */
  renderContent?: (content: string) => ComponentChildren;
}

export function Tooltip({ content, children, side = 'top', renderContent }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div
      class={css.tooltipRoot}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          class={`${css.tooltipContent} ${css.tooltipSide[side]}`}
        >
          {renderContent ? renderContent(content) : content}
        </div>
      )}
    </div>
  );
}
