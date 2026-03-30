/** Keyword management panel. */
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { keywordsSignal, personsSignal } from '../store/index.js';
import { displayName } from '@/i18n.js';
import { useDatabase } from '../db/index.js';
import * as s from '../styles/components.css.js';
import {
  Button,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from './ui.js';
import { Dialog, confirmDialog } from './ui/Dialog.js';
import type { Keyword } from '@labby/core';
import { i18n } from '@/i18n.js';

interface KeywordFormProps {
  initial?: Partial<Keyword>;
  onSave: (k: Keyword) => void;
  onCancel: () => void;
}

function KeywordForm({ initial, onSave, onCancel }: KeywordFormProps) {
  const { t } = i18n;
  const [nameEn, setNameEn] = useState(initial?.names?.['en'] ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.['zh'] ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.['ja'] ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  function handleSave() {
    if (!nameEn.trim()) return;
    onSave({
      id: initial?.id ?? nanoid(),
      name: nameEn.trim(),
      names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
      metadata: initial?.metadata ?? {},
      disabled: initial?.disabled,
      notes: notes.trim() || undefined,
    });
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

export function KeywordList() {
  const db = useDatabase();
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const persons = personsSignal.value;
  const [editing, setEditing] = useState<Keyword | null | 'new'>(null);

  /** Check if a keyword is referenced by any person */
  function isKeywordReferenced(id: string): boolean {
    return persons.some(p => p.keywordIds.includes(id));
  }

  async function handleSave(k: Keyword) {
    await db.keywords.put(k);
    keywordsSignal.value = await db.keywords.getAll();
    setEditing(null);
  }

  async function handleDisableToggle(k: Keyword) {
    const updated: Keyword = { ...k, disabled: !k.disabled };
    await db.keywords.put(updated);
    keywordsSignal.value = await db.keywords.getAll();
  }

  async function handleDelete(k: Keyword) {
    const referenced = isKeywordReferenced(k.id);
    const message = referenced
      ? `${t('deleteReferencedWarning')}\n\n${t('deleteHistory')}`
      : t('deleteHistory');
    confirmDialog(t('confirmDelete'), message, async () => {
      await db.keywords.delete(k.id);
      keywordsSignal.value = await db.keywords.getAll();
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
        items={keywords}
        columns={[
          { header: t('name') },
          { header: t('notes') },
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
    </div>
  );
}
