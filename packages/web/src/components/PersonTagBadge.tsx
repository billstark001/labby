import type { PersonTag } from '@labby/core';
import { displayName } from '@/i18n';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import * as s from '@/styles/components.css';

export function tagColorStyle(tag: PersonTag) {
  return assignInlineVars({ [s.tagBorderColor]: tag.color, [s.tagBackgroundColor]: `${tag.color}26` });
}

export function PersonTagBadge({ tag }: { tag: PersonTag }) {
  return <span class={`${s.badge} ${s.tagBadge}`} style={tagColorStyle(tag)}>
    <span aria-hidden="true" class={s.tagDot}>●</span> {displayName(tag)}
  </span>;
}
