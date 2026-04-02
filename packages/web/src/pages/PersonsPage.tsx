/** Person management panel. */
import { useEffect, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import {
  personsSignal,
  keywordsSignal,
  keywordMapSignal,
  schedulesSignal,
} from '../store/index.js';
import { fallbackEntityId } from '@/i18n.js';
import { displayName } from '@/i18n.js';
import { listPersonsPage, loadAllKeywords, loadAllSchedules, useDatabase } from '../db/index.js';
import * as s from '../styles/components.css.js';
import {
  Button,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '../components/ui.js';
import { Dialog, confirmDialog } from '../components/ui/Dialog.js';
import type { Person, Keyword } from '@labby/core';
import { i18n } from '@/i18n.js';

const MAX_KEYWORDS = 10;

// ---------------------------------------------------------------------------
// PersonForm
// ---------------------------------------------------------------------------

interface PersonFormProps {
  initial?: Partial<Person>;
  onSave: (p: Person, newKeywords: Keyword[]) => void;
  onCancel: () => void;
}

function PersonForm({ initial, onSave, onCancel }: PersonFormProps) {
  const { t } = i18n;
  const keywords = keywordsSignal.value;

  const [nameEn, setNameEn] = useState(initial?.names?.['en'] ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.['zh'] ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.['ja'] ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initial?.keywordIds ?? []);
  const [newKeywordName, setNewKeywordName] = useState('');
  const [newKeywords, setNewKeywords] = useState<Keyword[]>([]);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [keywordLimitHit, setKeywordLimitHit] = useState(false);

  const allKeywords = [...keywords, ...newKeywords];

  function toggle(id: string) {
    setKeywordLimitHit(false);
    setSelectedIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
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
      id: initial?.id ?? nanoid(),
      name: nameEn.trim(),
      names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
      metadata: initial?.metadata ?? {},
      keywordIds: selectedIds,
      disabled: initial?.disabled,
      notes: notes.trim() || undefined,
    }, newKeywords);
  }

  function handleAddKeyword() {
    const normalized = newKeywordName.trim();
    if (!normalized) return;
    const existing = allKeywords.find(keyword => keyword.name.toLowerCase() === normalized.toLowerCase());
    if (existing) {
      if (!selectedIds.includes(existing.id)) {
        if (selectedIds.length >= MAX_KEYWORDS) {
          setKeywordLimitHit(true);
          setNewKeywordName('');
          return;
        }
        setSelectedIds(prev => [...prev, existing.id]);
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
      id: nanoid(),
      name: normalized,
      names: { en: normalized, zh: '', ja: '' },
      metadata: {},
    };

    setNewKeywords(prev => [...prev, keyword]);
    setSelectedIds(prev => [...prev, keyword.id]);
    setNewKeywordName('');
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (EN)</label>
        <input
          class={s.input}
          value={nameEn}
          onInput={e => setNameEn((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (中文)</label>
        <input
          class={s.input}
          value={nameZh}
          onInput={e => setNameZh((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (日本語)</label>
        <input
          class={s.input}
          value={nameJa}
          onInput={e => setNameJa((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>
          {t('keywords')} ({selectedIds.length}/{MAX_KEYWORDS})
        </label>
        {keywordLimitHit && (
          <p class={`${s.text12} ${s.textDanger}`}>{t('keywordLimitReached')}</p>
        )}
        <div class={s.tagList}>
          {allKeywords.map(kw => (
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
          <input
            class={s.input}
            value={newKeywordName}
            onInput={e => setNewKeywordName((e.target as HTMLInputElement).value)}
          />
          <Button variant="secondary" onClick={handleAddKeyword}>
            {t('addKeyword')}
          </Button>
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('notes')}</label>
        <textarea
          class={s.input}
          rows={3}
          value={notes}
          onInput={e => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>
          {t('save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PersonList
// ---------------------------------------------------------------------------

export function PersonsPage() {
  const db = useDatabase();
  const { t } = i18n;
  const persons = personsSignal.value;
  const schedules = schedulesSignal.value;
  const [editing, setEditing] = useState<Person | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalItems, setTotalItems] = useState(0);

  async function refreshPersonsPage(targetPage = page, targetPageSize = pageSize) {
    const safePage = Math.max(1, targetPage);
    const offset = (safePage - 1) * targetPageSize;
    const result = await listPersonsPage(db, offset, targetPageSize);
    personsSignal.value = result.items;
    setTotalItems(result.total);

    const totalPages = Math.max(1, Math.ceil(result.total / targetPageSize));
    if (safePage > totalPages) {
      await refreshPersonsPage(totalPages, targetPageSize);
      return;
    }
    if (page !== safePage) {
      setPage(safePage);
    }
  }

  useEffect(() => {
    void loadAllKeywords(db);
    void loadAllSchedules(db);
  }, [db]);

  useEffect(() => {
    void refreshPersonsPage(page, pageSize);
  }, [db, page, pageSize]);

  /** Check if a person is referenced in any schedule */
  function isPersonReferenced(id: string): boolean {
    return schedules.some(plan =>
      plan.sessions.some(sess =>
        sess.presentations.some(
          p => p.presenterId === id || p.questionerIds.includes(id),
        ),
      ),
    );
  }

  async function handleSave(p: Person, newKeywords: Keyword[]) {
    await Promise.all(newKeywords.map(keyword => db.keywords.put(keyword)));
    await db.persons.put(p);
    await loadAllKeywords(db);
    await refreshPersonsPage();
    setEditing(null);
  }

  async function handleDisableToggle(p: Person) {
    const updated: Person = { ...p, disabled: !p.disabled };
    await db.persons.put(updated);
    await refreshPersonsPage();
  }

  async function handleDelete(p: Person) {
    const referenced = isPersonReferenced(p.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    confirmDialog(t('confirmDelete'), message, async () => {
      await db.persons.delete(p.id);
      await refreshPersonsPage();
    });
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navPersons')}</h2>
        <Button onClick={() => setEditing('new')}>{t('addPerson')}</Button>
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
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      <ResponsiveDataView
        items={persons}
        columns={[
          { header: t('name') },
          { header: t('keywords') },
          { header: t('notes') },
        ]}
        getKey={person => person.id}
        getDesktopRowProps={person => ({ style: { opacity: person.disabled ? 0.5 : 1 } })}
        getMobileCardProps={person => ({ style: { opacity: person.disabled ? 0.5 : 1 } })}
        renderDesktopRow={person => (
          <>
            <td class={s.td}>
              <div class={s.flexGapXs}>
                {displayName(person)}
                {person.disabled && (
                  <span class={s.badgeDisabled}>{t('disabled')}</span>
                )}
              </div>
            </td>
            <td class={s.td}>
              <div class={s.tagList}>
                {person.keywordIds.map(kid => {
                  const kw = keywordMapSignal.value.get(kid);
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
          </>
        )}
        renderMobileCard={person => (
          <>
            <div class={dataStyles.mobileHeader}>
              <div>
                <div class={dataStyles.mobileTitle}>{displayName(person)}</div>
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
                    ? person.keywordIds.map(kid => {
                      const kw = keywordMapSignal.value.get(kid);
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
        renderActions={person => (
          <>

            <Button variant="ghost" onClick={() => setEditing(person)}>
              {t('edit')}
            </Button>
            <Button variant="ghost" onClick={() => handleDisableToggle(person)}>
              {person.disabled ? t('enable') : t('disable')}
            </Button>
            <Button variant="danger" onClick={() => handleDelete(person)}>
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
