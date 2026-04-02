/**
 * Tooltip — business-layer wrapper with styled tooltip.
 *
 * Usage:
 *   <Tooltip content="Helpful hint">
 *     <button>Hover me</button>
 *   </Tooltip>
 */
import { type ComponentChildren } from 'preact';
import {
  Tooltip as PrimitiveTooltip,
} from '../../primitives/Tooltip';
import * as css from './Tooltip.css';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  children: ComponentChildren;
  side?: Side;
}

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <PrimitiveTooltip
      content={content}
      side={side}
      renderContent={(c: string) => <span class={css.tooltipContent}>{c}</span>}
    >
      {children}
    </PrimitiveTooltip>
  );
}
