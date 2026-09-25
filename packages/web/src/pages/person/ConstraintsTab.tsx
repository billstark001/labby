import { useEffect, useState } from 'preact/hooks';
import { previewConstraintPairs, type ConstraintTargetGroup, type PairOverlapStrategy, type Person, type PersonTag, type ScheduleConfig, type ScheduleConstraint } from '@labby/core';

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
import { PersonTagBadge } from '@/components/PersonTagBadge';
import { PersonMembershipPicker } from '@/components/PersonMembershipPicker';

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
  const [groups, setGroups] = useState<ConstraintTargetGroup[]>(() => {
    return !initial || initial.type === 'frequency-multiplier'
      ? [{ personIds: initial?.type === 'frequency-multiplier' ? initial.personIds : [],
        tagIds: initial?.type === 'frequency-multiplier' ? initial.tagIds : [] }]
      : initial.groups.length ? initial.groups : [{ personIds: [], tagIds: [] }];
  });
  const [overlapStrategy, setOverlapStrategy] = useState<PairOverlapStrategy>(
    initial?.type === 'frequency-multiplier' ? 'include-multi-group' : initial?.overlapStrategy ?? 'include-multi-group',
  );
  const initialWeight = initial?.type === 'frequency-multiplier' ? initial.weight ?? 1 : 1;
  const [weight, setWeight] = useState(String(initialWeight));
  const [boost, setBoost] = useState(String(initial?.type === 'affinity-boost' ? initial.boost ?? 2 : 2));
  const [baseline, setBaseline] = useState(String(initial?.type === 'frequency-multiplier' ? initial.baseline : 1));
  const [multiplier, setMultiplier] = useState(String(initial?.type === 'frequency-multiplier' ? initial.multiplier : 1));
  const [roleScope, setRoleScope] = useState<'presenter' | 'questioner' | 'both'>(
    initial?.type === 'frequency-multiplier' ? (initial.roleScope ?? 'presenter') : 'presenter',
  );
  function updateGroup(index: number, key: 'personIds' | 'tagIds', ids: string[]): void {
    setGroups(current => current.map((group, groupIndex) => groupIndex === index ? { ...group, [key]: ids } : group));
  }

  const pairGroups = groups.filter(group => group.personIds.length || group.tagIds.length);
  const first = groups[0];
  const pairFields = { groups, overlapStrategy };
  const previewRule = constraintType === 'no-overlap'
    ? { id: initial?.id ?? '', type: 'no-overlap' as const, ...pairFields }
    : { id: initial?.id ?? '', type: 'affinity-boost' as const, ...pairFields };
  const previewPairs = constraintType === 'frequency-multiplier' || pairGroups.length !== groups.length || !first.personIds.length && !first.tagIds.length
    ? [] : previewConstraintPairs(previewRule, persons);
  const personNames = new Map(persons.map(person => [person.id, displayName(person)]));

  function handleSave(): void {
    if (!first.personIds.length && !first.tagIds.length) return;
    if (constraintType !== 'frequency-multiplier' && pairGroups.length !== groups.length) return;

    if (constraintType === 'no-overlap') {
      onSave({
        id: initial?.id ?? crypto.randomUUID(),
        configId,
        type: 'no-overlap',
        disabled,
        ...pairFields,
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
        ...pairFields,
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
      personIds: first.personIds,
      tagIds: first.tagIds,
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
      {groups.slice(0, constraintType === 'frequency-multiplier' ? 1 : undefined).map((group, index) => (
        <div class={s.formGroup} key={index}>
          <div class={s.flexGapSm}>
            <label class={s.label}>{constraintType === 'frequency-multiplier' ? t('constraintTargets') : `${t('constraintGroup')} ${index + 1}`}</label>
            {index > 0 && <Button variant="secondary" onClick={() => setGroups(current => current.filter((_, i) => i !== index))}>{t('constraintRemoveGroup')}</Button>}
          </div>
          <PersonMembershipPicker persons={persons} selectedIds={group.personIds}
            onChange={ids => updateGroup(index, 'personIds', ids)}
            allowTags tags={tags} selectedTagIds={group.tagIds}
            onTagChange={ids => updateGroup(index, 'tagIds', ids)} />
        </div>
      ))}
      {constraintType !== 'frequency-multiplier' && <>
        <Button variant="secondary" onClick={() => setGroups(current => [...current, { personIds: [], tagIds: [] }])}>{t('constraintAddGroup')}</Button>
        <div class={s.formGroup}>
          <label class={s.label}>{t('constraintOverlapStrategy')}</label>
          <select class={s.input} value={overlapStrategy}
            onChange={event => setOverlapStrategy((event.target as HTMLSelectElement).value as PairOverlapStrategy)}>
            <option value="include-multi-group">{t('constraintOverlapInclude')}</option>
            <option value="exclusive-only">{t('constraintOverlapExclusive')}</option>
          </select>
        </div>
        <div class={s.formGroup}>
          <label class={s.label}>{t('constraintPreview')}</label>
          <p class={s.textMuted}>{t('constraintPreviewCount').replace('{0}', String(previewPairs.length))}</p>
          {pairGroups.length !== groups.length && <p class={s.textDanger}>{t('constraintEmptyGroup')}</p>}
          <div class={s.tagList}>
            {previewPairs.slice(0, 40).map(([left, right]) => <span class={s.badge} key={`${left}:${right}`}>
              {personNames.get(left)} ↔ {personNames.get(right)}
            </span>)}
          </div>
          {previewPairs.length > 40 && <p class={s.textMuted}>{t('constraintPreviewLimited')}</p>}
        </div>
      </>}
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
    const groups = constraint.type === 'frequency-multiplier'
      ? [{ personIds: constraint.personIds, tagIds: constraint.tagIds }] : constraint.groups;
    return <span class={s.flexGapSm}>{groups.map((item, index) =>
      <span key={index}>{index > 0 && ' ↔ '}{group(item.personIds, item.tagIds)}</span>)}</span>;
  }

  function summarizeParameters(constraint: ScheduleConstraint): string {
    if (constraint.type === 'no-overlap') {
      return `${t('constraintHardRule')} · ${t(constraint.overlapStrategy === 'exclusive-only' ? 'constraintOverlapExclusive' : 'constraintOverlapInclude')}`;
    }
    if (constraint.type === 'affinity-boost') {
      return `${t('constraintBoost')}: ${constraint.boost ?? 2} · ${t(constraint.overlapStrategy === 'exclusive-only' ? 'constraintOverlapExclusive' : 'constraintOverlapInclude')}`;
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
