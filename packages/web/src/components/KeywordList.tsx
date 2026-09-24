import { syncGraph } from '@/lib/graph-sync';
/** Keyword management panel. */
import { useEffect, useState } from 'preact/hooks';
import { KeywordForm } from './KeywordForm';
import { displayName } from '@/i18n';
import { buildKeywordReferenceCount, listKeywordsPage, readAllPaginated, readKeywordForeignKeys, useDatabase } from '../db/index';
import { useAsyncResource } from '@/lib/use-async-resource';
import { changedMemberships } from '@/lib/person-membership';
import * as s from '../styles/components.css';
import {
  Button,
  ContentSkeleton,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from './ui/index';
import { Dialog, confirmDialog } from './ui/Dialog';
import type { EntityListSortBy, Keyword, ListSortDirection } from '@labby/core';
import { i18n } from '@/i18n';
import { usePendingAction } from '@/lib/use-pending-action';

export function KeywordList() {
  const db = useDatabase();
  const { t } = i18n;
  const locale = i18n.lang.value;
  const [editing, setEditing] = useState<Keyword | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<EntityListSortBy>('modifiedAt');
  const [sortDirection, setSortDirection] = useState<ListSortDirection>('desc');
  const action = usePendingAction();
  const query = useAsyncResource(async () => {
    const result = await listKeywordsPage(db, {
      offset: (page - 1) * pageSize, limit: pageSize, sortBy, sortDirection, locale,
    });
    const bundle = await readKeywordForeignKeys(db, result.items.map(item => item.id));
    return { ...result, references: buildKeywordReferenceCount(bundle) };
  }, [db, page, pageSize, sortBy, sortDirection, locale]);
  const membershipQuery = useAsyncResource(async () => editing ? readAllPaginated(db.persons) : [], [db, editing === 'new' ? 'new' : editing?.id]);
  const pagedKeywords = query.data?.items ?? [];
  const keywordReferenceCount = query.data?.references ?? new Map<string, number>();
  useEffect(() => {
    if (query.status !== 'success' || !query.data) return;
    const lastPage = Math.max(1, Math.ceil(query.data.total / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [query.status, query.data, page, pageSize]);

  /** Check if a keyword is referenced by any person */
  function isKeywordReferenced(id: string): boolean {
    return (keywordReferenceCount.get(id) ?? 0) > 0;
  }

  async function handleSave(k: Keyword, memberIds: string[]) {
    await db.keywords.put(k);
    await Promise.all(changedMemberships(membershipQuery.data ?? [], 'keywordIds', k.id, memberIds)
      .map(person => db.persons.put(person)));
    await Promise.all([query.refetch(), syncGraph(db)]);
    setEditing(null);
  }

  async function handleDelete(k: Keyword) {
    const referenced = isKeywordReferenced(k.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    setEditing(null);
    confirmDialog(t('confirmDelete'), message, async () => {
      await action.run(`delete:${k.id}`, async () => {
        await db.keywords.delete(k.id);
        await Promise.all([query.refetch(), syncGraph(db)]);
      });
    });
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navKeywords')}</h2>
        <Button disabled={!query.data} onClick={() => setEditing('new')}>{t('addKeyword')}</Button>
      </div>

      {editing && (
        <Dialog
          open={true}
          onClose={() => setEditing(null)}
          closeOnOverlayClick={false}
          title={editing === 'new' ? t('addKeyword') : t('edit')}
        >
          {membershipQuery.isInitialLoading ? <ContentSkeleton rows={4} /> : membershipQuery.error && !membershipQuery.data ?
            <p role="alert">{String(membershipQuery.error)} <Button onClick={() => void membershipQuery.refetch()}>{t('retry')}</Button></p> : <KeywordForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? undefined : editing}
            persons={membershipQuery.data ?? []}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            onDelete={editing === 'new' ? undefined : () => void handleDelete(editing)}
          />}
        </Dialog>
      )}

      {query.isInitialLoading ? <ContentSkeleton rows={5} /> : query.error && !query.data ? (
        <div role="alert" class={s.card}>
          <p class={s.textDanger}>{String(query.error)}</p>
          <Button variant="secondary" busy={query.isPending} onClick={() => void query.refetch()}>{t('retry')}</Button>
        </div>
      ) : <div aria-busy={query.isRefetching}>
      {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" busy={query.isPending} onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
      <ResponsiveDataView
        sorting={{
          key: sortBy, direction: sortDirection,
          options: [
            {key:'name',label:t('name')}, {key:'notes',label:t('notes')},
            {key:'disabled',label:t('disabled')},
            {key:'modifiedAt',label:t('modifiedAt'),defaultDirection:'desc'},
          ],
          onChange: (key, direction) => {setSortBy(key as EntityListSortBy);setSortDirection(direction);setPage(1);},
        }}
        items={pagedKeywords}
        columns={[
          { header: t('name'), sortKey: 'name' },
          { header: t('notes'), sortKey: 'notes' },
          { header: t('disabled'), sortKey: 'disabled' },
          { header: t('modifiedAt'), sortKey: 'modifiedAt' },
        ]}
        getKey={kw => kw.id}
        getDesktopRowProps={kw => ({ style: { opacity: kw.disabled ? 0.5 : 1 } })}
        renderDesktopRow={kw => (
          <>
            <td class={s.td}>
              <div class={s.flexGapXs}>
                {displayName(kw)}
                {kw.disabled && (
                  <span class={s.badgeDisabled}>{t('disabled')}</span>
                )}
              </div>
            </td>
            <td class={`${s.td} ${s.notesCell}`}>
              {kw.notes && <span class={s.textMuted}>{kw.notes}</span>}
            </td>
            <td class={s.td}>{kw.disabled ? t('disabled') : '—'}</td>
            <td class={s.td}>{kw.modifiedAt ? new Date(kw.modifiedAt!).toLocaleString() : '—'}</td>
          </>
        )}
        renderMobileCard={kw => (
          <>
            <div class={dataStyles.mobileHeader}>
              <div>
                <div class={dataStyles.mobileTitle}>{displayName(kw)}</div>
                {kw.disabled && (
                  <div class={dataStyles.mobileSubtitle}>
                    <span class={s.badgeDisabled}>{t('disabled')}</span>
                  </div>
                )}
              </div>
            </div>
            <div class={dataStyles.mobileFields}>
              <ResponsiveDataField label={t('notes')} valueClass={s.notesCell}>
                {kw.notes ? <span class={s.textMuted}>{kw.notes}</span> : '—'}
              </ResponsiveDataField>
            </div>
          </>
        )}
        renderActions={kw => (
          <Button variant="ghost" onClick={() => setEditing(kw)}>{t('edit')}</Button>
        )}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={query.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={nextPageSize => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
      </div>}
    </div>
  );
}
