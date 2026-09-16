import { toast } from './ui/Toast';
import { syncGraph } from '@/lib/graph-sync';
/** Keyword management panel. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { KeywordForm } from './KeywordForm';
import { displayName } from '@/i18n';
import { buildKeywordReferenceCount, listKeywordsPage, readKeywordForeignKeys, useDatabase } from '../db/index';
import * as s from '../styles/components.css';
import {
  Button,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from './ui/index';
import { Dialog, confirmDialog } from './ui/Dialog';
import type { EntityListSortBy, Keyword, ListSortDirection } from '@labby/core';
import { i18n } from '@/i18n';

export function KeywordList() {
  const db = useDatabase();
  const { t } = i18n;
  const [pagedKeywords, setPagedKeywords] = useState<Keyword[]>([]);
  const [editing, setEditing] = useState<Keyword | null | 'new'>(null);
  const request = useRef(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<EntityListSortBy>('modifiedAt');
  const [sortDirection, setSortDirection] = useState<ListSortDirection>('desc');
  const [totalItems, setTotalItems] = useState(0);
  const [keywordReferenceCount, setKeywordReferenceCount] = useState<Map<string, number>>(new Map());


  async function refreshForeignKeyContext(keywordIds: string[], ticket: number) {
    if (keywordIds.length === 0) {
      setKeywordReferenceCount(new Map());
      return;
    }
    const bundle = await readKeywordForeignKeys(db, keywordIds);
    if (ticket !== request.current) return;
    setKeywordReferenceCount(buildKeywordReferenceCount(bundle));
  }

  async function refreshKeywordsPage(
    targetPage = page,
    targetPageSize = pageSize,
    targetSortBy = sortBy,
    targetSortDirection = sortDirection,
  ) {
    const ticket = ++request.current;
    const safePage = Math.max(1, targetPage);
    const offset = (safePage - 1) * targetPageSize;
    const result = await listKeywordsPage(db, {
      offset,
      limit: targetPageSize,
      sortBy: targetSortBy,
      sortDirection: targetSortDirection,
    });
    if (ticket !== request.current) return;
    setPagedKeywords(result.items);
    await refreshForeignKeyContext(result.items.map((item) => item.id), ticket);
    if (ticket !== request.current) return;
    setTotalItems(result.total);

    const totalPages = Math.max(1, Math.ceil(result.total / targetPageSize));
    if (safePage > totalPages) {
      await refreshKeywordsPage(totalPages, targetPageSize);
      return;
    }
    if (page !== safePage) {
      setPage(safePage);
    }
  }


  useEffect(() => {
    void refreshKeywordsPage(page, pageSize).catch(error => toast.error(String(error)));
    return () => { request.current++; };
  }, [db, page, pageSize, sortBy, sortDirection]);

  /** Check if a keyword is referenced by any person */
  function isKeywordReferenced(id: string): boolean {
    return (keywordReferenceCount.get(id) ?? 0) > 0;
  }

  async function handleSave(k: Keyword) {
    await db.keywords.put(k);
    await Promise.all([refreshKeywordsPage(), syncGraph(db)]);
    setEditing(null);
  }

  async function handleDisableToggle(k: Keyword) {
    const updated: Keyword = { ...k, disabled: !k.disabled, modifiedAt: Date.now() };
    await db.keywords.put(updated);
    await Promise.all([refreshKeywordsPage(), syncGraph(db)]);
  }

  async function handleDelete(k: Keyword) {
    const referenced = isKeywordReferenced(k.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    confirmDialog(t('confirmDelete'), message, async () => {
      await db.keywords.delete(k.id);
      await Promise.all([refreshKeywordsPage(), syncGraph(db)]);
    });
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navKeywords')}</h2>
        <Button onClick={() => setEditing('new')}>{t('addKeyword')}</Button>
      </div>

      {editing && (
        <Dialog
          open={true}
          onClose={() => setEditing(null)}
          closeOnOverlayClick={false}
          title={editing === 'new' ? t('addKeyword') : t('edit')}
        >
          <KeywordForm
            initial={editing === 'new' ? undefined : editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      <ResponsiveDataView
        sorting={{
          key: sortBy, direction: sortDirection,
          options: [
            {key:'name',label:t('name')}, {key:'notes',label:t('notes')},
            {key:'modifiedAt',label:t('modifiedAt'),defaultDirection:'desc'},
          ],
          onChange: (key, direction) => {setSortBy(key as EntityListSortBy);setSortDirection(direction);setPage(1);},
        }}
        items={pagedKeywords}
        columns={[
          { header: t('name'), sortKey: 'name' },
          { header: t('notes'), sortKey: 'notes' },
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
          <>
            <Button variant="ghost" onClick={() => setEditing(kw)}>
              {t('edit')}
            </Button>
            <Button variant="ghost" onClick={() => handleDisableToggle(kw)}>
              {kw.disabled ? t('enable') : t('disable')}
            </Button>
            <Button variant="danger" onClick={() => handleDelete(kw)}>
              {t('delete')}
            </Button>
          </>
        )}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={nextPageSize => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
    </div>
  );
}
