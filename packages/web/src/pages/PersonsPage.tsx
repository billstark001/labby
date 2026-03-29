/** Person management panel. */
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import {
  personsSignal,
  keywordsSignal,
  keywordMapSignal,
} from '../store/index.js';
import { fallbackEntityId } from '@/i18n.js';
import { displayName } from '@/i18n.js';
import { db } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from '../components/ui.js';
import { Dialog, confirmDialog } from '../components/ui/Dialog.js';
import type { Person, Keyword } from '@labby/core';
import { i18n } from '@/i18n.js';

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

  const allKeywords = [...keywords, ...newKeywords];

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
    }, newKeywords);
  }

  function handleAddKeyword() {
    const normalized = newKeywordName.trim();
    if (!normalized) return;
    const existing = allKeywords.find(keyword => keyword.name.toLowerCase() === normalized.toLowerCase());
    if (existing) {
      if (!selectedIds.includes(existing.id)) {
        setSelectedIds(prev => [...prev, existing.id]);
      }
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
        <label class={s.label}>{t('keywords')}</label>
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
  const { t } = i18n;
  const persons = personsSignal.value;
  const [editing, setEditing] = useState<Person | null | 'new'>(null);

  async function handleSave(p: Person, newKeywords: Keyword[]) {
    await Promise.all(newKeywords.map(keyword => db.keywords.put(keyword)));
    await db.persons.put(p);
    keywordsSignal.value = await db.keywords.getAll();
    personsSignal.value = await db.persons.getAll();
    setEditing(null);
  }

  async function handleDelete(id: string) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.persons.delete(id);
      personsSignal.value = await db.persons.getAll();
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

      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{t('name')}</th>
            <th class={s.th}>{t('keywords')}</th>
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
                    return (
                      <span key={kid} class={s.badge}>
                        {kw ? displayName(kw) : fallbackEntityId(kid)}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td class={s.td}>
                <div class={s.flexGapXs}>
                  <Button variant="ghost" onClick={() => setEditing(p)}>
                    {t('edit')}
                  </Button>
                  <Button variant="danger" onClick={() => handleDelete(p.id)}>
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
