import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import type { Keyword } from '@labby/core';
import { i18n } from '@/i18n';
import { Button } from './ui/common';
import * as s from '@/styles/components.css';

interface KeywordFormProps {
  initial?: Partial<Keyword>;
  onSave: (k: Keyword) => void | Promise<void>;
  onCancel: () => void;
}

export function KeywordForm({ initial, onSave, onCancel }: KeywordFormProps) {
  const { t } = i18n;
  const [nameEn, setNameEn] = useState(initial?.names?.['en'] ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.['zh'] ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.['ja'] ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!nameEn.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        id: initial?.id ?? nanoid(),
        name: nameEn.trim(),
        names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
        metadata: initial?.metadata ?? {},
        disabled: initial?.disabled,
        notes: notes.trim() || undefined,
        modifiedAt: Date.now(),
      });
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (EN)</label>
        <input
          class={s.input}
          value={nameEn}
          onInput={(e) => setNameEn((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (中文)</label>
        <input
          class={s.input}
          value={nameZh}
          onInput={(e) => setNameZh((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Name (日本語)</label>
        <input
          class={s.input}
          value={nameJa}
          onInput={(e) => setNameJa((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('notes')}</label>
        <textarea
          class={s.input}
          rows={3}
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" disabled={saving || !nameEn.trim()} onClick={handleSave}>
          {t('save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
