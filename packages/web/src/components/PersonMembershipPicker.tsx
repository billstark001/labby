import { useState } from 'preact/hooks';
import type { Person, PersonTag } from '@labby/core';
import { displayName, i18n } from '@/i18n';
import { PersonTagMembershipPicker } from './PersonTagMembershipPicker';
import * as s from '@/styles/components.css';

interface PersonMembershipPickerProps {
  persons: Person[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  cannotAdd?: (person: Person) => boolean;
  label?: string;
  allowTags?: boolean;
  tags?: PersonTag[];
  selectedTagIds?: string[];
  onTagChange?: (ids: string[]) => void;
  tagLabel?: string;
}

/** Searchable person chips shared by reverse tag and keyword membership editors. */
export function PersonMembershipPicker({ persons, selectedIds, onChange, disabled, cannotAdd, label, allowTags = false, tags = [], selectedTagIds = [], onTagChange, tagLabel }: PersonMembershipPickerProps) {
  const { t } = i18n;
  const [query, setQuery] = useState('');
  const collator = new Intl.Collator(i18n.lang.value, { sensitivity: 'base', numeric: true });
  const visible = persons.filter(person => displayName(person).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(selectedIds.includes(b.id)) - Number(selectedIds.includes(a.id))
      || collator.compare(displayName(a), displayName(b)) || a.id.localeCompare(b.id));
  return <><div class={s.formGroup}>
    <label class={s.label}>{label ?? t('selectPeople')} ({selectedIds.length})</label>
    <input class={s.input} type="search" value={query} disabled={disabled} placeholder={t('searchPerson')}
      onInput={event => setQuery((event.target as HTMLInputElement).value)} />
    <div class={s.tagList} style={{ maxHeight: '12rem', overflowY: 'auto' }}>
      {visible.map(person => {
        const selected = selectedIds.includes(person.id);
        return <button type="button" key={person.id} disabled={disabled || (!selected && cannotAdd?.(person))}
          aria-pressed={selected} class={`${s.badgeSelectable} ${selected ? s.badgeSelectableActive : ''}`}
          onClick={() => onChange(selected ? selectedIds.filter(id => id !== person.id) : [...selectedIds, person.id])}>
          {displayName(person)}
        </button>;
      })}
    </div>
  </div>
    {allowTags && <PersonTagMembershipPicker tags={tags} selectedIds={selectedTagIds} onChange={ids => onTagChange?.(ids)} disabled={disabled} label={tagLabel} />}
  </>;
}
