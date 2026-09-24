import type { PersonTag } from '@labby/core';
import { displayName } from '@/i18n';
import * as s from '@/styles/components.css';

export function tagColorStyle(tag: PersonTag) {
  return { border: `1px solid ${tag.color}`, backgroundColor: `${tag.color}26` };
}

export function PersonTagBadge({ tag }: { tag: PersonTag }) {
  return <span class={s.badge} style={tagColorStyle(tag)}>
    <span aria-hidden="true" style={{ color: tag.color }}>●</span> {displayName(tag)}
  </span>;
}
