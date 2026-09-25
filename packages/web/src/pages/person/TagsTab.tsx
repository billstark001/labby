import { useState } from 'preact/hooks';
import type { Person, PersonTag } from '@labby/core';

import { Button, ContentSkeleton, ResponsiveDataField, ResponsiveDataView, responsiveDataStyles as dataStyles } from '@/components/ui';
import { PersonTagBadge } from '@/components/PersonTagBadge';
import { PersonMembershipPicker } from '@/components/PersonMembershipPicker';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { readAllPaginated, useDatabase } from '@/db';
import { changedMemberships } from '@/lib/person-membership';
import { displayName, i18n } from '@/i18n';
import { useAsyncResource } from '@/lib/use-async-resource';
import * as s from '@/styles/components.css';

export function randomTagColor(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hue = bytes[0]! / 255 * 360;
  const saturation = 0.55 + bytes[1]! / 255 * 0.18;
  const value = 0.72 + bytes[2]! / 255 * 0.13;
  const chroma = value * saturation;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
    : segment < 2 ? [secondary, chroma, 0]
    : segment < 3 ? [0, chroma, secondary]
    : segment < 4 ? [0, secondary, chroma]
    : segment < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  const offset = value - chroma;
  return `#${[red, green, blue].map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function TagEditor({ initial, isNew, persons, onSave, onDelete, onClose, pending }: {
  initial: PersonTag; isNew: boolean; persons: Person[]; onSave: (tag: PersonTag, memberIds: string[]) => void; onDelete?: () => void; onClose: () => void; pending: boolean;
}) {
  const { t } = i18n;
  const [nameEn, setNameEn] = useState(initial.names.en);
  const [nameZh, setNameZh] = useState(initial.names.zh ?? '');
  const [nameJa, setNameJa] = useState(initial.names.ja ?? '');
  const [color, setColor] = useState(initial.color);
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [memberIds, setMemberIds] = useState(persons.filter(person => person.tagIds?.includes(initial.id)).map(person => person.id));
  return <Dialog open onClose={onClose} title={isNew ? t('addPersonTag') : t('edit')} closeOnOverlayClick={false}
    actions={<>
      {onDelete && <Button variant="danger" disabled={pending} onClick={onDelete}>{t('delete')}</Button>}
      <Button busy={pending} disabled={!nameEn.trim()} onClick={() => onSave({ ...initial, name: nameEn.trim(), names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() }, color, notes: notes.trim() || undefined, modifiedAt: Date.now() }, memberIds)}>{t('save')}</Button>
      <Button variant="secondary" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
    </>}>
    <div class={s.formGroup}>
      <label class={s.label}>Name (EN)</label>
      <input class={s.input} value={nameEn} onInput={event => setNameEn((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>Name (中文)</label>
      <input class={s.input} value={nameZh} onInput={event => setNameZh((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>Name (日本語)</label>
      <input class={s.input} value={nameJa} onInput={event => setNameJa((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>{t('color')}</label>
      <input type="color" value={color} onInput={event => setColor((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>{t('notes')}</label>
      <textarea class={s.input} value={notes} onInput={event => setNotes((event.target as HTMLTextAreaElement).value)} />
    </div>
    <PersonMembershipPicker persons={persons} selectedIds={memberIds} onChange={setMemberIds} disabled={pending} />
  </Dialog>;
}

export function TagsTab() {
  const db = useDatabase();
  const { t } = i18n;
  const query = useAsyncResource(async () => {
    const [tags, persons] = await Promise.all([
      readAllPaginated(db.personTags), readAllPaginated(db.persons),
    ]);
    return { tags, persons };
  }, [db]);
  const [editing, setEditing] = useState<PersonTag | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'members'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const memberCounts = new Map<string, number>();
  for (const person of query.data?.persons ?? [] as Person[])
    for (const tagId of person.tagIds ?? []) memberCounts.set(tagId, (memberCounts.get(tagId) ?? 0) + 1);
  const collator = new Intl.Collator(i18n.lang.value, { sensitivity: 'base', numeric: true });
  const visible = (query.data?.tags ?? []).filter(tag => `${Object.values(tag.names).join(' ')} ${tag.notes ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => sort === 'members'
      ? ((memberCounts.get(a.id) ?? 0) - (memberCounts.get(b.id) ?? 0)) * (sortDirection === 'asc' ? 1 : -1) || collator.compare(displayName(a), displayName(b)) || a.id.localeCompare(b.id)
      : collator.compare(displayName(a), displayName(b)) * (sortDirection === 'asc' ? 1 : -1) || a.id.localeCompare(b.id));

  async function save(tag: PersonTag, memberIds: string[]) {
    if (pendingId) return;
    setPendingId(tag.id);
    try {
      await db.personTags.put(tag);
      await Promise.all(changedMemberships(query.data?.persons ?? [], 'tagIds', tag.id, memberIds)
        .map(person => db.persons.put(person)));
      await query.refetch(); setEditing(null);
    }
    catch (error) { toast.error(String(error)); }
    finally { setPendingId(null); }
  }

  function remove(tag: PersonTag) {
    setEditing(null);
    confirmDialog(t('confirmDelete'), t('deletePersonTagWarning'), async () => {
      if (pendingId) return;
      setPendingId(tag.id);
      try { await db.personTags.delete(tag.id); await query.refetch(); }
      finally { setPendingId(null); }
    });
  }

  return <div>
    <div class={s.toolbar}>
      <h2 class={s.sectionTitle}>{t('personTags')}</h2>
      <Button disabled={!query.data || pendingId !== null} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', names: { en: '', zh: '', ja: '' }, color: randomTagColor() })}>{t('addPersonTag')}</Button>
    </div>
    <div class={s.toolbar}>
      <input class={`${s.input} ${s.searchFlexInput}`} type="search" aria-label={t('search')} placeholder={t('search')} value={search} onInput={event => setSearch((event.target as HTMLInputElement).value)} />
      <select class={s.input} aria-label={t('sortBy')} value={sort} onChange={event => setSort((event.target as HTMLSelectElement).value as 'name' | 'members')}>
        <option value="name">{t('name')}</option>
        <option value="members">{t('tagMembers')}</option>
      </select>
    </div>
    {query.isInitialLoading ? <ContentSkeleton rows={5} /> : <div aria-busy={query.isRefetching}>
      {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" busy={query.isPending} onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
      <ResponsiveDataView
        items={visible}
        columns={[{ header: t('name'), sortKey: 'name' }, { header: t('tagMembers'), sortKey: 'members' }, { header: t('notes') }]}
        sorting={{ key: sort, direction: sortDirection, options: [{ key: 'name', label: t('name') }, { key: 'members', label: t('tagMembers') }], onChange: (key, direction) => { setSort(key as 'name' | 'members'); setSortDirection(direction); } }}
        getKey={tag => tag.id}
        renderDesktopRow={tag => <><td class={s.td}><PersonTagBadge tag={tag} /></td><td class={s.td}>{memberCounts.get(tag.id) ?? 0}</td><td class={s.td}>{tag.notes ?? '—'}</td></>}
        renderMobileCard={tag => <><div class={dataStyles.mobileHeader}><div class={dataStyles.mobileTitle}><PersonTagBadge tag={tag} /></div></div><div class={dataStyles.mobileFields}><ResponsiveDataField label={t('tagMembers')}>{memberCounts.get(tag.id) ?? 0}</ResponsiveDataField>{tag.notes && <ResponsiveDataField label={t('notes')}>{tag.notes}</ResponsiveDataField>}</div></>}
        renderActions={tag => <Button variant="ghost" disabled={pendingId !== null} onClick={() => setEditing(tag)}>{t('edit')}</Button>}
      />
    </div>}
    {editing && <TagEditor key={editing.id} initial={editing} persons={query.data?.persons ?? []} isNew={!query.data?.tags.some(tag => tag.id === editing.id)} pending={pendingId === editing.id} onSave={(tag, ids) => void save(tag, ids)} onDelete={query.data?.tags.some(tag => tag.id === editing.id) ? () => remove(editing) : undefined} onClose={() => setEditing(null)} />}
  </div>;
}
