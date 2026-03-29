/** Person management panel. */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import {
  personsSignal,
  keywordsSignal,
  keywordMapSignal,
  t,
  displayName,
} from '../store/index.js';
import { db } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';
import type { Person, Keyword } from '@labby/core';

// ---------------------------------------------------------------------------
// PersonForm
// ---------------------------------------------------------------------------

interface PersonFormProps {
  initial?: Partial<Person>;
  onSave: (p: Person) => void;
  onCancel: () => void;
}

function PersonForm({ initial, onSave, onCancel }: PersonFormProps) {
  const strings = t.value;
  const keywords = keywordsSignal.value;

  const [nameEn, setNameEn] = useState(initial?.names?.['en'] ?? initial?.name ?? '');
  const [nameZh, setNameZh] = useState(initial?.names?.['zh'] ?? '');
  const [nameJa, setNameJa] = useState(initial?.names?.['ja'] ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initial?.keywordIds ?? []);

  function toggle(id: string) {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  }

  function handleSave() {
    if (!nameEn.trim()) return;
    onSave({
      id: initial?.id ?? nanoid(),
      name: nameEn.trim(),
      names: { en: nameEn.trim(), zh: nameZh.trim(), ja: nameJa.trim() },
      metadata: initial?.metadata ?? {},
      keywordIds: selectedIds,
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
        <label class={s.label}>{strings.keywords}</label>
        <div class={s.tagList}>
          {keywords.map(kw => (
            <button
              key={kw.id}
              class={s.badge}
              style={{
                opacity: selectedIds.includes(kw.id) ? 1 : 0.4,
                cursor: 'pointer',
              }}
              onClick={() => toggle(kw.id)}
            >
              {displayName(kw)}
            </button>
          ))}
        </div>
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

// ---------------------------------------------------------------------------
// PersonList
// ---------------------------------------------------------------------------

export function PersonList() {
  const strings = t.value;
  const persons = personsSignal.value;
  const [editing, setEditing] = useState<Person | null | 'new'>(null);

  async function handleSave(p: Person) {
    await db.persons.put(p);
    personsSignal.value = await db.persons.getAll();
    setEditing(null);
  }

  async function handleDelete(id: string) {
    if (!confirm(strings.confirmDelete)) return;
    await db.persons.delete(id);
    personsSignal.value = await db.persons.getAll();
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{strings.navPersons}</h2>
        <Button onClick={() => setEditing('new')}>{strings.addPerson}</Button>
      </div>

      {editing && (
        <div class={s.modalOverlay}>
          <div class={s.modalBox}>
            <h3 style={{ marginBottom: '16px' }}>
              {editing === 'new' ? strings.addPerson : strings.edit}
            </h3>
            <PersonForm
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
            <th class={s.th}>{strings.keywords}</th>
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {persons.map(p => (
            <tr key={p.id}>
              <td class={s.td}>{displayName(p)}</td>
              <td class={s.td}>
                <div class={s.tagList}>
                  {p.keywordIds.map(kid => {
                    const kw = keywordMapSignal.value.get(kid);
                    return kw ? (
                      <span key={kid} class={s.badge}>
                        {displayName(kw)}
                      </span>
                    ) : null;
                  })}
                </div>
              </td>
              <td class={s.td}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <Button variant="ghost" onClick={() => setEditing(p)}>
                    {strings.edit}
                  </Button>
                  <Button variant="danger" onClick={() => handleDelete(p.id)}>
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
