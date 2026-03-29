/** Keyword management panel. */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { keywordsSignal, t, displayName } from '../store/index.js';
import { db } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';
import type { Keyword } from '@labby/core';

interface KeywordFormProps {
  initial?: Partial<Keyword>;
  onSave: (k: Keyword) => void;
  onCancel: () => void;
}

function KeywordForm({ initial, onSave, onCancel }: KeywordFormProps) {
  const strings = t.value;
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
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button variant="primary" onClick={handleSave}>
          {strings.save}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {strings.cancel}
        </Button>
      </div>
    </div>
  );
}

export function KeywordList() {
  const strings = t.value;
  const keywords = keywordsSignal.value;
  const [editing, setEditing] = useState<Keyword | null | 'new'>(null);

  async function handleSave(k: Keyword) {
    await db.keywords.put(k);
    keywordsSignal.value = await db.keywords.getAll();
    setEditing(null);
  }

  async function handleDelete(id: string) {
    if (!confirm(strings.confirmDelete)) return;
    await db.keywords.delete(id);
    keywordsSignal.value = await db.keywords.getAll();
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{strings.navKeywords}</h2>
        <Button onClick={() => setEditing('new')}>{strings.addKeyword}</Button>
      </div>

      {editing && (
        <div class={s.modalOverlay}>
          <div class={s.modalBox}>
            <h3 style={{ marginBottom: '16px' }}>
              {editing === 'new' ? strings.addKeyword : strings.edit}
            </h3>
            <KeywordForm
              initial={editing === 'new' ? undefined : editing}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{strings.name}</th>
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map(kw => (
            <tr key={kw.id}>
              <td class={s.td}>{displayName(kw)}</td>
              <td class={s.td}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <Button variant="ghost" onClick={() => setEditing(kw)}>
                    {strings.edit}
                  </Button>
                  <Button variant="danger" onClick={() => handleDelete(kw.id)}>
                    {strings.delete}
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
