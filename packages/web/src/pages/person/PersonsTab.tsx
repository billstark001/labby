import { useEffect, useState } from 'preact/hooks';
import type { EntityListSortBy, Keyword, ListSortDirection, Person, PersonTag } from '@labby/core';

import { fallbackEntityId, displayName, i18n } from '@/i18n';
import { buildPersonReferenceCount, listPersonsPage, readAllPaginated, readPersonForeignKeys, useDatabase } from '@/db';
import { useAsyncResource } from '@/lib/use-async-resource';
import * as s from '@/styles/components.css';
import {
  Button,
  ContentSkeleton,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '@/components/ui';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';

const MAX_KEYWORDS = 10;

interface PersonFormProps {
  initial?: Partial<Person>;
  keywords: Keyword[];
  tags: PersonTag[];
  onSave: (p: Person, newKeywords: Keyword[]) => void;
  onCancel: () => void;
}

function PersonForm({ initial, keywords, tags, onSave, onCancel }: PersonFormProps) {
  const { t } = i18n;

  const [nameEn, setNameEn] = useState(initial?.names?.en ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.zh ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.ja ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initial?.keywordIds ?? []);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [newKeywordName, setNewKeywordName] = useState('');
  const [newKeywords, setNewKeywords] = useState<Keyword[]>([]);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [keywordLimitHit, setKeywordLimitHit] = useState(false);

  const allKeywords = [...keywords, ...newKeywords];

  function toggle(id: string) {
    setKeywordLimitHit(false);
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_KEYWORDS) {
        setKeywordLimitHit(true);
        return prev;
      }
      return [...prev, id];
    });
  }

  function handleSave() {
    if (!nameEn.trim()) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: nameEn.trim(),
      names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
      metadata: initial?.metadata ?? {},
      keywordIds: selectedIds,
      tagIds: selectedTagIds,
      disabled: initial?.disabled,
      notes: notes.trim() || undefined,
      modifiedAt: Date.now(),
    }, newKeywords);
  }

  function handleAddKeyword() {
    const normalized = newKeywordName.trim();
    if (!normalized) return;

    const existing = allKeywords.find((keyword) => keyword.name.toLowerCase() === normalized.toLowerCase());
    if (existing) {
      if (!selectedIds.includes(existing.id)) {
        if (selectedIds.length >= MAX_KEYWORDS) {
          setKeywordLimitHit(true);
          setNewKeywordName('');
          return;
        }
        setSelectedIds((prev) => [...prev, existing.id]);
      }
      setNewKeywordName('');
      return;
    }

    if (selectedIds.length >= MAX_KEYWORDS) {
      setKeywordLimitHit(true);
      setNewKeywordName('');
      return;
    }

    const keyword: Keyword = {
      id: crypto.randomUUID(),
      name: normalized,
      names: { en: normalized, zh: '', ja: '' },
      metadata: {},
      modifiedAt: Date.now(),
    };

    setNewKeywords((prev) => [...prev, keyword]);
    setSelectedIds((prev) => [...prev, keyword.id]);
    setNewKeywordName('');
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (EN)</label>
        <input class={s.input} value={nameEn} onInput={(e) => setNameEn((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('personTags')}</label>
        <div class={s.tagList}>
          {tags.map((tag) => (
            <button
              type="button"
              key={tag.id}
              class={`${s.badgeSelectable} ${selectedTagIds.includes(tag.id) ? s.badgeSelectableActive : ''}`}
              style={{ borderColor: tag.color, boxShadow: selectedTagIds.includes(tag.id) ? `inset 0 0 0 1px ${tag.color}` : undefined }}
              onClick={() => setSelectedTagIds(prev => prev.includes(tag.id) ? prev.filter(id => id !== tag.id) : [...prev, tag.id])}
            >
              <span style={{ color: tag.color }}>●</span> {tag.name}
            </button>
          ))}
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (中文)</label>
        <input class={s.input} value={nameZh} onInput={(e) => setNameZh((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (日本語)</label>
        <input class={s.input} value={nameJa} onInput={(e) => setNameJa((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>
          {t('keywords')} ({selectedIds.length}/{MAX_KEYWORDS})
        </label>
        {keywordLimitHit && <p class={`${s.text12} ${s.textDanger}`}>{t('keywordLimitReached')}</p>}
        <div class={s.tagList}>
          {allKeywords.map((kw) => (
            <button
              key={kw.id}
              class={`${s.badgeSelectable} ${selectedIds.includes(kw.id) ? s.badgeSelectableActive : ''}`}
              onClick={() => toggle(kw.id)}
            >
              {displayName(kw)}
            </button>
          ))}
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('addKeywordToNonePerson')}</label>
        <div class={s.flexGapSm}>
          <input class={s.input} value={newKeywordName} onInput={(e) => setNewKeywordName((e.target as HTMLInputElement).value)} />
          <Button variant="secondary" onClick={handleAddKeyword}>
            {t('addKeyword')}
          </Button>
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('notes')}</label>
        <textarea class={s.input} rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

function PersonTagManager({ onClose, tags, onChange }: { onClose: () => void; tags: PersonTag[]; onChange: () => Promise<unknown> }) {
  const db = useDatabase();
  const { t } = i18n;
  const [editing, setEditing] = useState<PersonTag | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [notes, setNotes] = useState('');

  function start(tag?: PersonTag) {
    setEditing(tag ?? { id: crypto.randomUUID(), name: '', color: '#2563eb' });
    setName(tag?.name ?? '');
    setColor(tag?.color ?? '#2563eb');
    setNotes(tag?.notes ?? '');
  }

  async function save() {
    if (!editing || !name.trim()) return;
    await db.personTags.put({
      ...editing,
      name: name.trim(),
      color,
      notes: notes.trim() || undefined,
      modifiedAt: Date.now(),
    });
    await onChange();
    setEditing(null);
  }

  async function remove(tag: PersonTag) {
    confirmDialog(t('confirmDelete'), t('deletePersonTagWarning'), async () => {
      await db.personTags.delete(tag.id);
      await onChange();
    });
  }

  return <Dialog open onClose={onClose} title={t('managePersonTags')} closeOnOverlayClick={false}>
    <div class={s.flexColGapMd}>
      {tags.map(tag => <div key={tag.id} class={s.metricRow}>
        <div>
          <span class={s.badge} style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span>
          {tag.notes && <p class={s.mutedParagraph}>{tag.notes}</p>}
        </div>
        <div class={s.flexGapSm}>
          <Button variant="ghost" onClick={() => start(tag)}>{t('edit')}</Button>
          <Button variant="danger" onClick={() => void remove(tag)}>{t('delete')}</Button>
        </div>
      </div>)}
      {editing ? <div class={s.card}>
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
          <Button onClick={() => void save()}>{t('save')}</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>{t('cancel')}</Button>
        </div>
      </div> : <Button variant="secondary" onClick={() => start()}>{t('addPersonTag')}</Button>}
    </div>
  </Dialog>;
}

export function PersonsTab() {
  const db = useDatabase();
  const { t } = i18n;
  const [editing, setEditing] = useState<Person | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<EntityListSortBy>('modifiedAt');
  const [sortDirection, setSortDirection] = useState<ListSortDirection>('desc');
  const [managingTags, setManagingTags] = useState(false);
  const query = useAsyncResource(async () => {
    const result = await listPersonsPage(db, {
      offset: (page - 1) * pageSize, limit: pageSize, sortBy, sortDirection,
    });
    const [bundle, tags, keywords] = await Promise.all([
      readPersonForeignKeys(db, result.items.map(item => item.id)),
      readAllPaginated(db.personTags),
      readAllPaginated(db.keywords),
    ]);
    return { ...result, bundle, tags, keywords, references: buildPersonReferenceCount(bundle) };
  }, [db, page, pageSize, sortBy, sortDirection]);
  const persons = query.data?.items ?? [];
  const tags = query.data?.tags ?? [];
  const keywords = query.data?.keywords ?? [];
  const keywordMap = new Map(keywords.map(keyword => [keyword.id, keyword]));
  const tagMap = new Map(tags.map(tag => [tag.id, tag]));
  const personReferenceCount = query.data?.references ?? new Map<string, number>();

  useEffect(() => {
    if (query.status !== 'success' || !query.data) return;
    const lastPage = Math.max(1, Math.ceil(query.data.total / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [query.status, query.data, page, pageSize]);

  function isPersonReferenced(id: string): boolean {
    return (personReferenceCount.get(id) ?? 0) > 0;
  }

  async function handleSave(p: Person, newKeywords: Keyword[]) {
    await Promise.all(newKeywords.map((keyword) => db.keywords.put(keyword)));
    await db.persons.put(p);
    await query.refetch();
    setEditing(null);
  }

  async function handleDisableToggle(p: Person) {
    const updated: Person = { ...p, disabled: !p.disabled, modifiedAt: Date.now() };
    await db.persons.put(updated);
    await query.refetch();
  }

  async function handleDelete(p: Person) {
    const referenced = isPersonReferenced(p.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    confirmDialog(t('confirmDelete'), message, async () => {
      await db.persons.delete(p.id);
      await query.refetch();
    });
  }

  return (
    <>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navPersons')}</h2>
        <div class={s.flexGapSm}>
          <Button variant="secondary" disabled={!query.data} onClick={() => setManagingTags(true)}>{t('managePersonTags')}</Button>
          <Button disabled={!query.data} onClick={() => setEditing('new')}>{t('addPerson')}</Button>
        </div>
      </div>

      {managingTags && <PersonTagManager tags={tags} onChange={query.refetch} onClose={() => setManagingTags(false)} />}

      {editing && (
        <Dialog
          open={true}
          onClose={() => setEditing(null)}
          closeOnOverlayClick={false}
          title={editing === 'new' ? t('addPerson') : t('edit')}
        >
          <PersonForm
            initial={editing === 'new' ? undefined : editing}
            keywords={keywords}
            tags={tags}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      {query.isInitialLoading ? <ContentSkeleton rows={5} /> : query.error && !query.data ? (
        <div role="alert" class={s.card}>
          <p class={s.textDanger}>{String(query.error)}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button>
        </div>
      ) : <div aria-busy={query.isRefetching}>
      {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
      <ResponsiveDataView
        sorting={{
          key: sortBy, direction: sortDirection,
          options: [
            {key:'name',label:t('name')}, {key:'notes',label:t('notes')},
            {key:'modifiedAt',label:t('modifiedAt'),defaultDirection:'desc'},
          ],
          onChange: (key, direction) => {setSortBy(key as EntityListSortBy);setSortDirection(direction);setPage(1);},
        }}
        items={persons}
        columns={[
          { header: t('name'), sortKey: 'name' },
          { header: t('keywords') },
          { header: t('notes'), sortKey: 'notes' },
          { header: t('modifiedAt'), sortKey: 'modifiedAt' },
        ]}
        getKey={(person) => person.id}
        getDesktopRowProps={(person) => ({ style: { opacity: person.disabled ? 0.5 : 1 } })}
        getMobileCardProps={(person) => ({ style: { opacity: person.disabled ? 0.5 : 1 } })}
        renderDesktopRow={(person) => (
          <>
            <td class={s.td}>
              <div class={s.flexGapXs}>
                {displayName(person)}
                {person.disabled && <span class={s.badgeDisabled}>{t('disabled')}</span>}
              </div>
              <div class={s.tagList}>
                {(person.tagIds ?? []).map(tagId => {
                  const tag = tagMap.get(tagId);
                  return tag ? <span key={tag.id} class={s.badge} style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span> : null;
                })}
              </div>
            </td>
            <td class={s.td}>
              <div class={s.tagList}>
                {person.keywordIds.map((kid) => {
                  const kw = keywordMap.get(kid);
                  return (
                    <span key={kid} class={s.badge}>
                      {kw ? displayName(kw) : fallbackEntityId(kid)}
                    </span>
                  );
                })}
              </div>
            </td>
            <td class={`${s.td} ${s.notesCell}`}>
              {person.notes && <span class={s.textMuted}>{person.notes}</span>}
            </td>
            <td class={s.td}>{person.modifiedAt ? new Date(person.modifiedAt!).toLocaleString() : '—'}</td>
          </>
        )}
        renderMobileCard={(person) => (
          <>
            <div class={dataStyles.mobileHeader}>
              <div>
                <div class={dataStyles.mobileTitle}>{displayName(person)}</div>
                <div class={s.tagList}>{(person.tagIds ?? []).map(tagId => {
                  const tag = tagMap.get(tagId);
                  return tag ? <span key={tag.id} class={s.badge} style={{ borderColor: tag.color, color: tag.color }}>{tag.name}</span> : null;
                })}</div>
                {person.disabled && (
                  <div class={dataStyles.mobileSubtitle}>
                    <span class={s.badgeDisabled}>{t('disabled')}</span>
                  </div>
                )}
              </div>
            </div>
            <div class={dataStyles.mobileFields}>
              <ResponsiveDataField label={t('keywords')}>
                <div class={s.tagList}>
                  {person.keywordIds.length > 0
                    ? person.keywordIds.map((kid) => {
                      const kw = keywordMap.get(kid);
                      return (
                        <span key={kid} class={s.badge}>
                          {kw ? displayName(kw) : fallbackEntityId(kid)}
                        </span>
                      );
                    })
                    : '—'}
                </div>
              </ResponsiveDataField>
              <ResponsiveDataField label={t('notes')} valueClass={s.notesCell}>
                {person.notes ? <span class={s.textMuted}>{person.notes}</span> : '—'}
              </ResponsiveDataField>
            </div>
          </>
        )}
        renderActions={(person) => (
          <>
            <Button variant="ghost" onClick={() => setEditing(person)}>{t('edit')}</Button>
            <Button variant="ghost" onClick={() => handleDisableToggle(person)}>
              {person.disabled ? t('enable') : t('disable')}
            </Button>
            <Button variant="danger" onClick={() => handleDelete(person)}>{t('delete')}</Button>
          </>
        )}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={query.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
      </div>}
    </>
  );
}
