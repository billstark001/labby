/** Keyword management panel. */
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { keywordsSignal } from '../store/index.js';
import { displayName } from '@/i18n.js';
import { db } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';
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

  function handleSave() {
    if (!nameEn.trim()) return;
    onSave({
      id: initial?.id ?? nanoid(),
      name: nameEn.trim(),
      names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
      metadata: initial?.metadata ?? {},
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
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const [editing, setEditing] = useState<Keyword | null | 'new'>(null);

  async function handleSave(k: Keyword) {
    await db.keywords.put(k);
    keywordsSignal.value = await db.keywords.getAll();
    setEditing(null);
  }

  async function handleDelete(id: string) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.keywords.delete(id);
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

      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{t('name')}</th>
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map(kw => (
            <tr key={kw.id}>
              <td class={s.td}>{displayName(kw)}</td>
              <td class={s.td}>
                <div class={s.flexGapXs}>
                  <Button variant="ghost" onClick={() => setEditing(kw)}>
                    {t('edit')}
                  </Button>
                  <Button variant="danger" onClick={() => handleDelete(kw.id)}>
                    {t('delete')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
