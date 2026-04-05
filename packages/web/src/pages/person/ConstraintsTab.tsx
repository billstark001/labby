import { useEffect, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import type { ScheduleConstraint } from '@labby/core';

import { configsSignal, constraintsSignal, personsSignal } from '@/store';
import { displayName, i18n } from '@/i18n';
import { listConstraintsPage, loadAllConfigs, loadAllConstraints, loadAllPersons, useDatabase } from '@/db';
import * as s from '@/styles/components.css';
import {
  Button,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '@/components/ui';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';

const MAX_KEYWORDS = 10;

type ConstraintType = 'no-overlap' | 'affinity-boost' | 'frequency-multiplier';

interface ConstraintFormProps {
  initial?: ScheduleConstraint;
  onSave: (constraint: ScheduleConstraint) => void;
  onCancel: () => void;
}

function constraintTypeLabel(type: ConstraintType, t: (key: string) => string): string {
  if (type === 'no-overlap') return t('constraintTypeNoOverlap');
  if (type === 'affinity-boost') return t('constraintTypeAffinityBoost');
  return t('constraintTypeFrequencyMultiplier');
}

function ConstraintForm({ initial, onSave, onCancel }: ConstraintFormProps) {
  const { t } = i18n;
  const persons = personsSignal.value;
  const configs = configsSignal.value;

  const [configId, setConfigId] = useState(initial?.configId ?? '');
  const [constraintType, setConstraintType] = useState<ConstraintType>(initial?.type ?? 'no-overlap');
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>(initial?.personIds ?? []);
  const initialWeight = initial?.type === 'affinity-boost' ? 1 : (initial?.weight ?? 1);
  const [weight, setWeight] = useState(String(initialWeight));
  const [boost, setBoost] = useState(String(initial?.type === 'affinity-boost' ? initial.boost ?? 2 : 2));
  const [baseline, setBaseline] = useState(String(initial?.type === 'frequency-multiplier' ? initial.baseline : 1));
  const [multiplier, setMultiplier] = useState(String(initial?.type === 'frequency-multiplier' ? initial.multiplier : 1));
  const [roleScope, setRoleScope] = useState<'presenter' | 'questioner' | 'both'>(
    initial?.type === 'frequency-multiplier' ? (initial.roleScope ?? 'presenter') : 'presenter',
  );
  const [personLimitHit, setPersonLimitHit] = useState(false);

  function toggleConstraintPerson(personId: string): void {
    setPersonLimitHit(false);
    setSelectedPersonIds((prev) => {
      if (prev.includes(personId)) return prev.filter((id) => id !== personId);
      if (prev.length >= MAX_KEYWORDS) {
        setPersonLimitHit(true);
        return prev;
      }
      return [...prev, personId];
    });
  }

  function handleSave(): void {
    if (selectedPersonIds.length === 0) return;

    if (constraintType === 'no-overlap') {
      onSave({
        id: initial?.id ?? nanoid(),
        configId,
        type: 'no-overlap',
        personIds: selectedPersonIds,
        weight: Number.parseFloat(weight) || 1,
        modifiedAt: Date.now(),
      });
      return;
    }

    if (constraintType === 'affinity-boost') {
      onSave({
        id: initial?.id ?? nanoid(),
        configId,
        type: 'affinity-boost',
        personIds: selectedPersonIds,
        boost: Number.parseFloat(boost) || 2,
        modifiedAt: Date.now(),
      });
      return;
    }

    onSave({
      id: initial?.id ?? nanoid(),
      configId,
      type: 'frequency-multiplier',
      personIds: selectedPersonIds,
      baseline: Math.max(0, Number.parseFloat(baseline) || 0),
      multiplier: Number.parseFloat(multiplier) || 1,
      roleScope,
      weight: Number.parseFloat(weight) || 1,
      modifiedAt: Date.now(),
    });
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('constraintConfig')}</label>
        <select class={s.input} value={configId} onChange={(e) => setConfigId((e.target as HTMLSelectElement).value)}>
          <option value="">{t('constraintAllConfigs')}</option>
          {configs.map((config) => (
            <option key={config.id} value={config.id}>{config.id}</option>
          ))}
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('constraintType')}</label>
        <select
          class={s.input}
          value={constraintType}
          onChange={(e) => setConstraintType((e.target as HTMLSelectElement).value as ConstraintType)}
        >
          <option value="no-overlap">{constraintTypeLabel('no-overlap', t)}</option>
          <option value="affinity-boost">{constraintTypeLabel('affinity-boost', t)}</option>
          <option value="frequency-multiplier">{constraintTypeLabel('frequency-multiplier', t)}</option>
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>
          {t('constraintPersons')} ({selectedPersonIds.length}/{MAX_KEYWORDS})
        </label>
        {personLimitHit && <p class={`${s.text12} ${s.textDanger}`}>{t('keywordLimitReached')}</p>}
        <div class={s.tagList}>
          {persons.map((person) => (
            <button
              key={person.id}
              class={`${s.badgeSelectable} ${selectedPersonIds.includes(person.id) ? s.badgeSelectableActive : ''}`}
              onClick={() => toggleConstraintPerson(person.id)}
            >
              {displayName(person)}
            </button>
          ))}
        </div>
      </div>
      {(constraintType === 'no-overlap' || constraintType === 'frequency-multiplier') && (
        <div class={s.formGroup}>
          <label class={s.label}>{t('constraintWeight')}</label>
          <input class={s.input} value={weight} onInput={(e) => setWeight((e.target as HTMLInputElement).value)} />
        </div>
      )}
      {constraintType === 'affinity-boost' && (
        <div class={s.formGroup}>
          <label class={s.label}>{t('constraintBoost')}</label>
          <input class={s.input} value={boost} onInput={(e) => setBoost((e.target as HTMLInputElement).value)} />
        </div>
      )}
      {constraintType === 'frequency-multiplier' && (
        <>
          <div class={s.formGroup}>
            <label class={s.label}>{t('constraintBaseline')}</label>
            <input class={s.input} value={baseline} onInput={(e) => setBaseline((e.target as HTMLInputElement).value)} />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('constraintMultiplier')}</label>
            <input class={s.input} value={multiplier} onInput={(e) => setMultiplier((e.target as HTMLInputElement).value)} />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('constraintRoleScope')}</label>
            <select
              class={s.input}
              value={roleScope}
              onChange={(e) => setRoleScope((e.target as HTMLSelectElement).value as 'presenter' | 'questioner' | 'both')}
            >
              <option value="presenter">{t('constraintRolePresenter')}</option>
              <option value="questioner">{t('constraintRoleQuestioner')}</option>
              <option value="both">{t('constraintRoleBoth')}</option>
            </select>
          </div>
        </>
      )}
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

export function ConstraintsTab() {
  const db = useDatabase();
  const { t } = i18n;
  const constraints = constraintsSignal.value;
  const configs = configsSignal.value;
  const persons = personsSignal.value;

  const [editing, setEditing] = useState<ScheduleConstraint | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalItems, setTotalItems] = useState(0);

  async function refreshConstraintsPage(targetPage = page, targetPageSize = pageSize) {
    const safePage = Math.max(1, targetPage);
    const offset = (safePage - 1) * targetPageSize;
    const result = await listConstraintsPage(db, offset, targetPageSize);
    constraintsSignal.value = result.items;
    setTotalItems(result.total);

    const totalPages = Math.max(1, Math.ceil(result.total / targetPageSize));
    if (safePage > totalPages) {
      await refreshConstraintsPage(totalPages, targetPageSize);
      return;
    }
    if (page !== safePage) {
      setPage(safePage);
    }
  }

  useEffect(() => {
    void Promise.all([loadAllPersons(db), loadAllConfigs(db)]);
  }, [db]);

  useEffect(() => {
    void refreshConstraintsPage(page, pageSize);
  }, [db, page, pageSize]);

  function findConfigLabel(configId?: string): string {
    if (!configId) return t('constraintAllConfigs');
    const config = configs.find((item) => item.id === configId);
    return config?.id ?? configId;
  }

  function summarizePersons(personIds: string[]): string {
    if (personIds.length === 0) return '—';
    const map = new Map(persons.map((person) => [person.id, displayName(person)]));
    const labels = personIds.slice(0, 3).map((id) => map.get(id) ?? id);
    const suffix = personIds.length > 3 ? ` +${personIds.length - 3}` : '';
    return `${labels.join(', ')}${suffix}`;
  }

  function summarizeParameters(constraint: ScheduleConstraint): string {
    if (constraint.type === 'no-overlap') {
      return `${t('constraintWeight')}: ${constraint.weight ?? 1}`;
    }
    if (constraint.type === 'affinity-boost') {
      return `${t('constraintBoost')}: ${constraint.boost ?? 2}`;
    }
    return [
      `${t('constraintBaseline')}: ${constraint.baseline}`,
      `${t('constraintMultiplier')}: ${constraint.multiplier}`,
      `${t('constraintWeight')}: ${constraint.weight ?? 1}`,
      `${t('constraintRoleScope')}: ${constraint.roleScope ?? 'presenter'}`,
    ].join(' · ');
  }

  async function handleSaveConstraint(next: ScheduleConstraint): Promise<void> {
    await db.constraints.put({ ...next, modifiedAt: Date.now() });
    await loadAllConstraints(db);
    await refreshConstraintsPage();
    setEditing(null);
  }

  async function handleDeleteConstraint(constraint: ScheduleConstraint): Promise<void> {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.constraints.delete(constraint.id);
      await loadAllConstraints(db);
      await refreshConstraintsPage();
    });
  }

  return (
    <>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('constraintsTab')}</h2>
        <Button onClick={() => setEditing('new')}>{t('addConstraint')}</Button>
      </div>

      {editing && (
        <Dialog
          open={true}
          onClose={() => setEditing(null)}
          closeOnOverlayClick={false}
          title={editing === 'new' ? t('addConstraint') : t('editConstraint')}
        >
          <ConstraintForm
            initial={editing === 'new' ? undefined : editing}
            onSave={handleSaveConstraint}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}

      <ResponsiveDataView
        items={constraints}
        columns={[
          { header: t('constraintType') },
          { header: t('constraintConfig') },
          { header: t('constraintPersons') },
          { header: t('constraintParams') },
        ]}
        getKey={(constraint) => constraint.id}
        renderDesktopRow={(constraint) => (
          <>
            <td class={s.td}>{constraintTypeLabel(constraint.type, t)}</td>
            <td class={s.td}>{findConfigLabel(constraint.configId)}</td>
            <td class={s.td}>
              <span class={s.textMuted}>{summarizePersons(constraint.personIds)}</span>
            </td>
            <td class={s.td}>
              <span class={s.textMuted}>{summarizeParameters(constraint)}</span>
            </td>
          </>
        )}
        renderMobileCard={(constraint) => (
          <>
            <div class={dataStyles.mobileHeader}>
              <div class={dataStyles.mobileTitle}>{constraintTypeLabel(constraint.type, t)}</div>
              <div class={dataStyles.mobileSubtitle}>{findConfigLabel(constraint.configId)}</div>
            </div>
            <div class={dataStyles.mobileFields}>
              <ResponsiveDataField label={t('constraintPersons')}>
                <span class={s.textMuted}>{summarizePersons(constraint.personIds)}</span>
              </ResponsiveDataField>
              <ResponsiveDataField label={t('constraintParams')}>
                <span class={s.textMuted}>{summarizeParameters(constraint)}</span>
              </ResponsiveDataField>
            </div>
          </>
        )}
        renderActions={(constraint) => (
          <>
            <Button variant="ghost" onClick={() => setEditing(constraint)}>{t('edit')}</Button>
            <Button variant="danger" onClick={() => void handleDeleteConstraint(constraint)}>{t('delete')}</Button>
          </>
        )}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
    </>
  );
}
