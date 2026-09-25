import { useEffect, useState } from 'preact/hooks';
import type { EntityListSortBy, Keyword, ListSortDirection, Person, PersonTag } from '@labby/core';

import { fallbackEntityId, displayName, i18n } from '@/i18n';
import { buildPersonReferenceCount, listPersonsPage, readAllPaginated, readPersonForeignKeys, useDatabase } from '@/db';
import { useAsyncResource } from '@/lib/use-async-resource';
import { formatLocalDateTime24 } from '@/lib/date-time';
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
import { toast } from '@/components/ui/Toast';
import { PersonTagBadge } from '@/components/PersonTagBadge';
import { PersonTagMembershipPicker } from '@/components/PersonTagMembershipPicker';

const MAX_KEYWORDS = 10;

interface PersonFormProps {
  initial?: Partial<Person>;
  keywords: Keyword[];
  tags: PersonTag[];
  onSave: (p: Person, newKeywords: Keyword[]) => void;
  onCancel: () => void;
  onDelete?: () => void;
  pending: boolean;
}

function PersonForm({ initial, keywords, tags, onSave, onCancel, onDelete, pending }: PersonFormProps) {
  const { t } = i18n;

  const [nameEn, setNameEn] = useState(initial?.names?.en ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.zh ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.ja ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initial?.keywordIds ?? []);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [newKeywordName, setNewKeywordName] = useState('');
  const [newKeywords, setNewKeywords] = useState<Keyword[]>([]);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
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
      disabled,
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
      <PersonTagMembershipPicker tags={tags} selectedIds={selectedTagIds} onChange={setSelectedTagIds} />
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
      <label class={s.flexGapSm}><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.currentTarget.checked)} /> {t('disabled')}</label>
      <div class={s.flexGapSm}>
        <Button variant="primary" busy={pending} onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
        {onDelete && <Button variant="danger" disabled={pending} onClick={onDelete}>{t('delete')}</Button>}
      </div>
    </div>
  );
}

export function PersonsTab() {
  const db = useDatabase();
  const { t } = i18n;
  const locale = i18n.lang.value;
  const [editing, setEditing] = useState<Person | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<EntityListSortBy>('modifiedAt');
  const [sortDirection, setSortDirection] = useState<ListSortDirection>('desc');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const query = useAsyncResource(async () => {
    const result = await listPersonsPage(db, {
      offset: (page - 1) * pageSize, limit: pageSize, sortBy, sortDirection, locale,
    });
    const [bundle, tags, keywords] = await Promise.all([
      readPersonForeignKeys(db, result.items.map(item => item.id)),
      readAllPaginated(db.personTags),
      readAllPaginated(db.keywords),
    ]);
    return { ...result, bundle, tags, keywords, references: buildPersonReferenceCount(bundle) };
  }, [db, page, pageSize, sortBy, sortDirection, locale]);
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
    if (pendingId) return;
    setPendingId(p.id);
    try {
      await Promise.all(newKeywords.map((keyword) => db.keywords.put(keyword)));
      await db.persons.put(p);
      await query.refetch();
      setEditing(null);
    } catch (error) { toast.error(String(error)); }
    finally { setPendingId(null); }
  }

  async function handleDelete(p: Person) {
    const referenced = isPersonReferenced(p.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    setEditing(null);
    confirmDialog(t('confirmDelete'), message, async () => {
      if (pendingId) return;
      setPendingId(p.id);
      try { await db.persons.delete(p.id); await query.refetch(); }
      finally { setPendingId(null); }
    });
  }

  return (
    <>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navPersons')}</h2>
        <div class={s.flexGapSm}>
          <Button disabled={!query.data} onClick={() => setEditing('new')}>{t('addPerson')}</Button>
        </div>
      </div>

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
            onDelete={editing === 'new' ? undefined : () => void handleDelete(editing)}
            pending={pendingId !== null}
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
            {key:'tags',label:t('personTags')}, {key:'keywords',label:t('keywords')}, {key:'disabled',label:t('disabled')},
            {key:'modifiedAt',label:t('modifiedAt'),defaultDirection:'desc'},
          ],
          onChange: (key, direction) => {setSortBy(key as EntityListSortBy);setSortDirection(direction);setPage(1);},
        }}
        items={persons}
        columns={[
          { header: t('name'), sortKey: 'name' },
          { header: t('personTags'), sortKey: 'tags' },
          { header: t('keywords'), sortKey: 'keywords' },
          { header: t('notes'), sortKey: 'notes' },
          { header: t('disabled'), sortKey: 'disabled' },
          { header: t('modifiedAt'), sortKey: 'modifiedAt' },
        ]}
        getKey={(person) => person.id}
        getDesktopRowProps={(person) => ({ class: person.disabled ? s.dimmedRow : undefined })}
        getMobileCardProps={(person) => ({ class: person.disabled ? s.dimmedRow : undefined })}
        renderDesktopRow={(person) => (
          <>
            <td class={s.td}>
              <div class={s.flexGapXs}>
                {displayName(person)}
                {person.disabled && <span class={s.badgeDisabled}>{t('disabled')}</span>}
              </div>
            </td>
            <td class={s.td}><div class={s.tagList}>{(person.tagIds ?? []).map(tagId => {
              const tag = tagMap.get(tagId);
              return tag ? <PersonTagBadge key={tag.id} tag={tag} /> : null;
            })}</div></td>
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
            <td class={s.td}>{person.disabled ? t('disabled') : '—'}</td>
            <td class={s.td}>{person.modifiedAt ? formatLocalDateTime24(person.modifiedAt) : '—'}</td>
          </>
        )}
        renderMobileCard={(person) => (
          <>
            <div class={dataStyles.mobileHeader}>
              <div>
                <div class={dataStyles.mobileTitle}>{displayName(person)}</div>
                <div class={s.tagList}>{(person.tagIds ?? []).map(tagId => {
                  const tag = tagMap.get(tagId);
                  return tag ? <PersonTagBadge key={tag.id} tag={tag} /> : null;
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
          <Button variant="ghost" onClick={() => setEditing(person)}>{t('edit')}</Button>
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
