import { useEffect, useState } from 'preact/hooks';
import type { Person, PersonTag, ScheduleConfig, ScheduleConstraint } from '@labby/core';

import { displayName, i18n } from '@/i18n';
import { listConstraintsPage, readAllPaginated, useDatabase } from '@/db';
import { useAsyncResource } from '@/lib/use-async-resource';
import { usePendingAction } from '@/lib/use-pending-action';
import * as s from '@/styles/components.css';
import { getScheduleConfigLabel } from '@/lib/scheduleConfigLabel';
import {
  Button,
  ContentSkeleton,
  Pagination,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '@/components/ui';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';
import { PersonTagBadge, tagColorStyle } from '@/components/PersonTagBadge';

type ConstraintType = 'no-overlap' | 'affinity-boost' | 'frequency-multiplier';

interface ConstraintFormProps {
  initial?: ScheduleConstraint;
  persons: Person[];
  tags: PersonTag[];
  configs: ScheduleConfig[];
  onSave: (constraint: ScheduleConstraint) => void;
  onCancel: () => void;
  onDelete?: () => void;
  pending: boolean;
}

function constraintTypeLabel(type: ConstraintType, t: (key: string) => string): string {
  if (type === 'no-overlap') return t('constraintTypeNoOverlap');
  if (type === 'affinity-boost') return t('constraintTypeAffinityBoost');
  return t('constraintTypeFrequencyMultiplier');
}

function ConstraintForm({ initial, persons, tags, configs, onSave, onCancel, onDelete, pending }: ConstraintFormProps) {
  const { t } = i18n;

  const [configId, setConfigId] = useState(initial?.configId ?? '');
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
  const [constraintType, setConstraintType] = useState<ConstraintType>(initial?.type ?? 'no-overlap');
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>(initial?.personIds ?? []);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [otherPersonIds, setOtherPersonIds] = useState<string[]>(initial?.type === 'frequency-multiplier' ? [] : initial?.otherPersonIds ?? []);
  const [otherTagIds, setOtherTagIds] = useState<string[]>(initial?.type === 'frequency-multiplier' ? [] : initial?.otherTagIds ?? []);
  const [useOtherGroup, setUseOtherGroup] = useState(initial?.type !== 'frequency-multiplier' && Boolean(initial?.otherPersonIds?.length || initial?.otherTagIds?.length));
  const initialWeight = initial?.type === 'frequency-multiplier' ? initial.weight ?? 1 : 1;
  const [weight, setWeight] = useState(String(initialWeight));
  const [boost, setBoost] = useState(String(initial?.type === 'affinity-boost' ? initial.boost ?? 2 : 2));
  const [baseline, setBaseline] = useState(String(initial?.type === 'frequency-multiplier' ? initial.baseline : 1));
  const [multiplier, setMultiplier] = useState(String(initial?.type === 'frequency-multiplier' ? initial.multiplier : 1));
  const [roleScope, setRoleScope] = useState<'presenter' | 'questioner' | 'both'>(
    initial?.type === 'frequency-multiplier' ? (initial.roleScope ?? 'presenter') : 'presenter',
  );
  function toggle(id: string, values: string[], setValues: (values: string[]) => void): void {
    setValues(values.includes(id) ? values.filter(value => value !== id) : [...values, id]);
  }

  function handleSave(): void {
    if (selectedPersonIds.length + selectedTagIds.length === 0) return;
    if (useOtherGroup && constraintType !== 'frequency-multiplier' && otherPersonIds.length + otherTagIds.length === 0) return;
    const cross = useOtherGroup && constraintType !== 'frequency-multiplier'
      ? { otherPersonIds, otherTagIds } : {};

    if (constraintType === 'no-overlap') {
      onSave({
        id: initial?.id ?? crypto.randomUUID(),
        configId,
        type: 'no-overlap',
        disabled,
        personIds: selectedPersonIds,
        tagIds: selectedTagIds,
        ...cross,
        modifiedAt: Date.now(),
      });
      return;
    }

    if (constraintType === 'affinity-boost') {
      onSave({
        id: initial?.id ?? crypto.randomUUID(),
        configId,
        type: 'affinity-boost',
        disabled,
        personIds: selectedPersonIds,
        tagIds: selectedTagIds,
        ...cross,
        boost: Number.isFinite(Number(boost)) && Number(boost) > 0 ? Number(boost) : 2,
        modifiedAt: Date.now(),
      });
      return;
    }

    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      configId,
      type: 'frequency-multiplier',
      disabled,
      personIds: selectedPersonIds,
      tagIds: selectedTagIds,
      baseline: Math.max(0, Number(baseline) || 0),
      multiplier: Math.max(0, Number(multiplier) || 0),
      roleScope,
      weight: Math.max(0, Number(weight) || 0),
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
            <option key={config.id} value={config.id}>{getScheduleConfigLabel(config)}</option>
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
        <label class={s.label}>{t('constraintTargets')}</label>
        <div class={s.tagList}>
          {persons.map((person) => (
            <button
              type="button"
              key={person.id}
              class={`${s.badgeSelectable} ${selectedPersonIds.includes(person.id) ? s.badgeSelectableActive : ''}`}
              onClick={() => toggle(person.id, selectedPersonIds, setSelectedPersonIds)}
            >
              {displayName(person)}
            </button>
          ))}
          {tags.map(tag => <button type="button" key={tag.id}
            class={`${s.badgeSelectable} ${selectedTagIds.includes(tag.id) ? s.badgeSelectableActive : ''}`}
            style={tagColorStyle(tag)}
            onClick={() => toggle(tag.id, selectedTagIds, setSelectedTagIds)}>
            <span style={{ color: tag.color }}>●</span> {displayName(tag)}
          </button>)}
        </div>
      </div>
      {constraintType !== 'frequency-multiplier' && <div class={s.formGroup}>
        <label class={s.label}><input type="checkbox" checked={useOtherGroup}
          onChange={event => setUseOtherGroup((event.target as HTMLInputElement).checked)} /> {t('constraintUseOtherGroup')}</label>
        {useOtherGroup && <>
          <p class={s.textMuted}>{t('constraintOtherTargets')}</p>
          <div class={s.tagList}>
            {persons.map(person => <button type="button" key={person.id}
              class={`${s.badgeSelectable} ${otherPersonIds.includes(person.id) ? s.badgeSelectableActive : ''}`}
              onClick={() => toggle(person.id, otherPersonIds, setOtherPersonIds)}>{displayName(person)}</button>)}
            {tags.map(tag => <button type="button" key={tag.id}
              class={`${s.badgeSelectable} ${otherTagIds.includes(tag.id) ? s.badgeSelectableActive : ''}`}
              style={tagColorStyle(tag)}
              onClick={() => toggle(tag.id, otherTagIds, setOtherTagIds)}>
              <span style={{ color: tag.color }}>●</span> {displayName(tag)}</button>)}
          </div>
        </>}
      </div>}
      {constraintType === 'frequency-multiplier' && (
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
      <label class={s.flexGapSm}><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.currentTarget.checked)} /> {t('disabled')}</label>
      <div class={s.flexGapSm}>
        <Button variant="primary" busy={pending} onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
        {onDelete && <Button variant="danger" disabled={pending} onClick={onDelete}>{t('delete')}</Button>}
      </div>
    </div>
  );
}

export function ConstraintsTab() {
  const db = useDatabase();
  const { t } = i18n;
  const action = usePendingAction();
  const [editing, setEditing] = useState<ScheduleConstraint | null | 'new'>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const query = useAsyncResource(async () => {
    const [result, persons, tags, configs] = await Promise.all([
      listConstraintsPage(db, (page - 1) * pageSize, pageSize),
      readAllPaginated(db.persons),
      readAllPaginated(db.personTags),
      readAllPaginated(db.configs),
    ]);
    return { ...result, persons, tags, configs };
  }, [db, page, pageSize]);
  const constraints = query.data?.items ?? [];
  const persons = query.data?.persons ?? [];
  const tags = query.data?.tags ?? [];
  const configs = query.data?.configs ?? [];
  useEffect(() => {
    if (query.status !== 'success' || !query.data) return;
    const lastPage = Math.max(1, Math.ceil(query.data.total / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [query.status, query.data, page, pageSize]);

  function findConfigLabel(configId?: string): string {
    if (!configId) return t('constraintAllConfigs');
    const config = configs.find((item) => item.id === configId);
    return config ? getScheduleConfigLabel(config) : configId;
  }

  function summarizeTargets(constraint: ScheduleConstraint) {
    const map = new Map(persons.map((person) => [person.id, displayName(person)]));
    const tagMap = new Map(tags.map(tag => [tag.id, tag]));
    const group = (personIds: string[], tagIds: string[]) => <span class={s.tagList}>
      {personIds.map(id => <span key={id} class={s.badge}>{map.get(id) ?? id}</span>)}
      {tagIds.map(id => { const tag = tagMap.get(id); return tag ? <PersonTagBadge key={id} tag={tag} /> : <span key={id} class={s.badge}>{id}</span>; })}
      {!personIds.length && !tagIds.length && '—'}
    </span>;
    const otherPersonIds = constraint.type === 'frequency-multiplier' ? [] : constraint.otherPersonIds ?? [];
    const otherTagIds = constraint.type === 'frequency-multiplier' ? [] : constraint.otherTagIds ?? [];
    return <span class={s.flexGapSm}>{group(constraint.personIds, constraint.tagIds)}
      {(otherPersonIds.length > 0 || otherTagIds.length > 0) && <> ↔ {group(otherPersonIds, otherTagIds)}</>}
    </span>;
  }

  function summarizeParameters(constraint: ScheduleConstraint): string {
    if (constraint.type === 'no-overlap') {
      return t('constraintHardRule');
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
    await action.run(`save:${next.id}`, async () => {
      await db.constraints.put({ ...next, modifiedAt: Date.now() });
      await query.refetch();
      setEditing(null);
    });
  }

  async function handleDeleteConstraint(constraint: ScheduleConstraint): Promise<void> {
    setEditing(null);
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await action.run(`delete:${constraint.id}`, async () => {
        await db.constraints.delete(constraint.id);
        await query.refetch();
      });
    });
  }

  return (
    <>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('constraintsTab')}</h2>
        <Button disabled={!query.data} onClick={() => setEditing('new')}>{t('addConstraint')}</Button>
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
            persons={persons}
            tags={tags}
            configs={configs}
            onSave={handleSaveConstraint}
            onCancel={() => setEditing(null)}
            onDelete={editing === 'new' ? undefined : () => void handleDeleteConstraint(editing)}
            pending={action.pendingKey?.startsWith('save:') ?? false}
          />
        </Dialog>
      )}

      {query.isInitialLoading ? <ContentSkeleton rows={5} /> : query.error && !query.data ? (
        <div role="alert" class={s.card}>
          <p class={s.textDanger}>{String(query.error)}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button>
        </div>
      ) : <div aria-busy={query.isRefetching}>
      {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
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
            <td class={s.td}>{constraintTypeLabel(constraint.type, t)} {constraint.disabled && <span class={s.badgeDisabled}>{t('disabled')}</span>}</td>
            <td class={s.td}>{findConfigLabel(constraint.configId)}</td>
            <td class={s.td}>
              <span class={s.textMuted}>{summarizeTargets(constraint)}</span>
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
                <span class={s.textMuted}>{summarizeTargets(constraint)}</span>
              </ResponsiveDataField>
              <ResponsiveDataField label={t('constraintParams')}>
                <span class={s.textMuted}>{summarizeParameters(constraint)}</span>
              </ResponsiveDataField>
            </div>
          </>
        )}
        renderActions={(constraint) => (
          <Button variant="ghost" onClick={() => setEditing(constraint)}>{t('edit')}</Button>
        )}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        totalItems={query.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
      />
      </div>}
    </>
  );
}
