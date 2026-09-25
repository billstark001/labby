import { useState } from 'preact/hooks';
import type { PersonTag } from '@labby/core';
import { displayName, i18n } from '@/i18n';
import { tagColorStyle } from './PersonTagBadge';
import * as s from '@/styles/components.css';

interface PersonTagMembershipPickerProps {
  tags: PersonTag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
}

export function PersonTagMembershipPicker({ tags, selectedIds, onChange, disabled, label }: PersonTagMembershipPickerProps) {
  const { t } = i18n;
  const [query, setQuery] = useState('');
  const collator = new Intl.Collator(i18n.lang.value, { sensitivity: 'base', numeric: true });
  const visible = tags.filter(tag => displayName(tag).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(selectedIds.includes(b.id)) - Number(selectedIds.includes(a.id))
      || collator.compare(displayName(a), displayName(b)) || a.id.localeCompare(b.id));
  return <div class={s.formGroup}>
    <label class={s.label}>{label ?? t('personTags')} ({selectedIds.length})</label>
    <input class={s.input} type="search" value={query} disabled={disabled} placeholder={t('search')}
      onInput={event => setQuery((event.target as HTMLInputElement).value)} />
    <div class={s.tagList} style={{ maxHeight: '12rem', overflowY: 'auto' }}>
      {visible.map(tag => {
        const selected = selectedIds.includes(tag.id);
        return <button type="button" key={tag.id} disabled={disabled} aria-pressed={selected}
          class={`${s.badgeSelectable} ${selected ? s.badgeSelectableActive : ''}`}
          style={tagColorStyle(tag)}
          onClick={() => onChange(selected ? selectedIds.filter(id => id !== tag.id) : [...selectedIds, tag.id])}>
          <span aria-hidden="true" style={{ color: tag.color }}>●</span> {displayName(tag)}
        </button>;
      })}
    </div>
  </div>;
}
