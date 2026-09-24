import { useState } from 'preact/hooks';
import type { Person, PersonTag } from '@labby/core';

import { Button, ContentSkeleton } from '@/components/ui';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { readAllPaginated, useDatabase } from '@/db';
import { i18n } from '@/i18n';
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

function TagEditor({ initial, onSave, onClose, pending }: {
  initial: PersonTag; onSave: (tag: PersonTag) => void; onClose: () => void; pending: boolean;
}) {
  const { t } = i18n;
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [notes, setNotes] = useState(initial.notes ?? '');
  return <Dialog open onClose={onClose} title={initial.modifiedAt ? t('edit') : t('addPersonTag')} closeOnOverlayClick={false}>
    <div class={s.formGroup}>
      <label class={s.label}>{t('name')}</label>
      <input class={s.input} value={name} onInput={event => setName((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>{t('color')}</label>
      <input type="color" value={color} onInput={event => setColor((event.target as HTMLInputElement).value)} />
    </div>
    <div class={s.formGroup}>
      <label class={s.label}>{t('notes')}</label>
      <textarea class={s.input} value={notes} onInput={event => setNotes((event.target as HTMLTextAreaElement).value)} />
    </div>
    <div class={s.flexGapSm}>
      <Button busy={pending} disabled={!name.trim()} onClick={() => onSave({ ...initial, name: name.trim(), color, notes: notes.trim() || undefined, modifiedAt: Date.now() })}>{t('save')}</Button>
      <Button variant="secondary" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
    </div>
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
  const [pendingId, setPendingId] = useState<string | null>(null);
  const memberCounts = new Map<string, number>();
  for (const person of query.data?.persons ?? [] as Person[])
    for (const tagId of person.tagIds ?? []) memberCounts.set(tagId, (memberCounts.get(tagId) ?? 0) + 1);
  const visible = (query.data?.tags ?? []).filter(tag => `${tag.name} ${tag.notes ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => sort === 'members'
      ? (memberCounts.get(b.id) ?? 0) - (memberCounts.get(a.id) ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      : a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  async function save(tag: PersonTag) {
    if (pendingId) return;
    setPendingId(tag.id);
    try { await db.personTags.put(tag); await query.refetch(); setEditing(null); }
    catch (error) { toast.error(String(error)); }
    finally { setPendingId(null); }
  }

  function remove(tag: PersonTag) {
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
      <Button disabled={!query.data || pendingId !== null} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', color: randomTagColor() })}>{t('addPersonTag')}</Button>
    </div>
    <div class={s.toolbar}>
      <input class={s.input} type="search" aria-label={t('search')} placeholder={t('search')} value={search} onInput={event => setSearch((event.target as HTMLInputElement).value)} />
      <select class={s.input} aria-label={t('sortBy')} value={sort} onChange={event => setSort((event.target as HTMLSelectElement).value as 'name' | 'members')}>
        <option value="name">{t('name')}</option>
        <option value="members">{t('tagMembers')}</option>
      </select>
    </div>
    {query.isInitialLoading ? <ContentSkeleton rows={5} /> : <div aria-busy={query.isRefetching}>
      {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" busy={query.isPending} onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
      {visible.map(tag => <div key={tag.id} class={s.metricRow}>
        <div>
          <span class={s.badge} style={{ borderColor: tag.color }}>{tag.name}</span>
          <span class={s.textMuted}> {t('tagMembers')}: {memberCounts.get(tag.id) ?? 0}</span>
          {tag.notes && <p class={s.mutedParagraph}>{tag.notes}</p>}
        </div>
        <div class={s.flexGapSm}>
          <Button variant="ghost" disabled={pendingId !== null} onClick={() => setEditing(tag)}>{t('edit')}</Button>
          <Button variant="danger" busy={pendingId === tag.id} disabled={pendingId !== null} onClick={() => remove(tag)}>{t('delete')}</Button>
        </div>
      </div>)}
    </div>}
    {editing && <TagEditor key={editing.id} initial={editing} pending={pendingId === editing.id} onSave={tag => void save(tag)} onClose={() => setEditing(null)} />}
  </div>;
}
