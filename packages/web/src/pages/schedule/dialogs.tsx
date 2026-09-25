import { useEffect, useMemo, useState } from 'preact/hooks';
import { getPersonSimilarity } from '@labby/core';
import type { MetricExplanation, Person, ScheduleMetrics, SimilarityLookup, SolverDiagnostics, ScheduleQualityReport } from '@labby/core';
import * as s from '@/styles/components.css';
import { Button, ResponsiveDataField, ResponsiveDataView, responsiveDataStyles as dataStyles } from '@/components/ui/index';
import { Dialog } from '@/components/ui/Dialog';
import { i18n } from '@/i18n';
import { displayName } from '@/i18n';

interface PersonSelectDialogProps {
  open: boolean;
  title: string;
  persons: Person[];
  currentPersonId?: string;
  excludedPersonIds: Set<string>;
  presenter?: Person;
  similarities?: SimilarityLookup;
  onSelect: (personId: string) => void;
  onClose: () => void;
}

export function PersonSelectDialog({
  open,
  title,
  persons,
  currentPersonId,
  excludedPersonIds,
  presenter,
  similarities,
  onSelect,
  onClose,
}: PersonSelectDialogProps) {
  const { t } = i18n;
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const visiblePeople = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return persons;
    return persons.filter(person => displayName(person).toLocaleLowerCase().includes(normalized));
  }, [persons, query]);
  const showSimilarity = Boolean(presenter && similarities);
  const personSimilarities = useMemo(() => {
    if (!presenter || !similarities) return null;
    return new Map(persons.map(person => [
      person.id,
      getPersonSimilarity(person.keywordIds, presenter.keywordIds, similarities),
    ]));
  }, [persons, presenter, similarities]);
  const similarityColor = (value: number): string => {
    if (value >= 1) return '#4caf50';
    if (value >= 0.75) return 'green';
    if (value >= 0.5) return '#b7c34a';
    if (value >= 0.25) return 'orange';
    return 'red';
  };
  if (!open) return null;
  return (
    <Dialog open={true} onClose={onClose} title={title}>
      <div class={s.formGroup}>
        <input
          class={s.input}
          type="search"
          value={query}
          placeholder={t('searchPerson')}
          onInput={event => setQuery((event.target as HTMLInputElement).value)}
          autoFocus
        />
      </div>
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        <table class={s.table}>
          <thead>
            <tr>
              <th class={s.th}>{t('name')}</th>
              {showSimilarity && <th class={s.th}>{t('similarity')}</th>}
              <th class={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {visiblePeople.map(person => {
              const disabled = person.id === currentPersonId || excludedPersonIds.has(person.id);
              const personSimilarity = personSimilarities?.get(person.id);
              return (
                <tr key={person.id}>
                  <td class={s.td}>{displayName(person)}</td>
                  {showSimilarity && (
                    <td class={s.td} style={{ color: person.id === currentPersonId ? 'inherit' : similarityColor(personSimilarity ?? 0) }}>
                      {personSimilarity?.toFixed(3)}
                    </td>
                  )}
                  <td class={s.td} style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <Button
                      variant={disabled ? 'ghost' : 'primary'}
                      disabled={disabled}
                      onClick={() => { onSelect(person.id); onClose(); }}
                    >
                      {t('confirm')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export interface MetricsDialogState {
  title: string;
  metrics: ScheduleMetrics;
  explanations: MetricExplanation[];
  diagnostics?: SolverDiagnostics;
  quality?: ScheduleQualityReport;
  personNames?: Record<string, string>;
}

const metricCopy: Record<string, [string, string]> = {
  uniformityPenalty: ['metricUniformity', 'metricUniformityHelp'],
  reciprocalPenalty: ['metricReciprocal', 'metricReciprocalHelp'],
  questionerPenalty: ['metricQuestionerPair', 'metricQuestionerPairHelp'],
  relevancePenalty: ['metricRelevance', 'metricRelevanceHelp'],
  presenterLoadPenalty: ['metricPresenterLoad', 'metricPresenterLoadHelp'],
  questionerCountPenalty: ['metricQuestionerLoad', 'metricQuestionerLoadHelp'],
  questionerGapPenalty: ['metricQuestionerGap', 'metricQuestionerGapHelp'],
  totalRolePenalty: ['metricTotalRole', 'metricTotalRoleHelp'],
  invalidAssignmentPenalty: ['metricInvalidAssignment', 'metricInvalidAssignmentHelp'],
  constraintPenalty: ['metricConstraint', 'metricConstraintHelp'],
  totalCost: ['metricTotalCost', 'metricTotalCostHelp'],
};

type QualitySortKey = 'name' | 'presentations' | 'targetGapDays' | 'minGapDays' | 'maxGapDays' | 'gapCoefficientOfVariation' | 'shortGapRate' | 'firstWaitDays' | 'lastWaitDays';

export function MetricsDialog({ state, onClose }: { state: MetricsDialogState | null; onClose: () => void }) {
  const [sortKey, setSortKey] = useState<QualitySortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  if (!state) return null;
  const { t } = i18n;
  const collator = new Intl.Collator(i18n.lang.value, { sensitivity: 'base', numeric: true });
  const qualityPersons = [...(state.quality?.persons ?? [])].sort((left, right) => {
    if (sortKey === 'name') return collator.compare(state.personNames?.[left.personId] ?? left.personId, state.personNames?.[right.personId] ?? right.personId) * (sortDirection === 'asc' ? 1 : -1) || left.personId.localeCompare(right.personId);
    const a = left[sortKey]; const b = right[sortKey];
    if (a === null || b === null) return a === b ? left.personId.localeCompare(right.personId) : a === null ? 1 : -1;
    return (a - b) * (sortDirection === 'asc' ? 1 : -1) || left.personId.localeCompare(right.personId);
  });
  const days = (value: number | null) => value === null ? '—' : value.toFixed(1);
  return (
    <Dialog open={true} onClose={onClose} title={state.title} width="min(1080px, 94vw)">
      {state.diagnostics && <div class={s.formGroup}>
        <strong>{t('solverSearchDiagnostics')}</strong>
        <div>{t('solverCostChange')}: {state.diagnostics.initialCost.toFixed(2)} → {state.diagnostics.finalCost.toFixed(2)}</div>
        <div>{t('solverIterations')}: {state.diagnostics.iterations} · {t('solverAccepted')}: {state.diagnostics.accepted} · {t('solverRestarts')}: {state.diagnostics.restarts}</div>
        <div>{t('solverInvalidNeighbors')}: {state.diagnostics.invalidNeighbors} · {t('solverUnchangedNeighbors')}: {state.diagnostics.unchangedNeighbors} · {state.diagnostics.durationMs} ms</div>
      </div>}
      <div class={s.formGroup}>
        <p class={s.textMuted}>{t('metricLowerBetter')}</p>
        {state.explanations.map(item => (
          <div key={item.key} class={`${s.text14} ${s.mb8}`}>
            <strong>{t(metricCopy[item.key]?.[0] ?? item.key)}</strong>: {item.value.toFixed(3)}
            <div class={s.textMuted}>{t(metricCopy[item.key]?.[1] ?? item.key)}</div>
          </div>
        ))}
      </div>
      {state.quality && <div class={s.formGroup}>
        <strong>{t('scheduleQuality')}</strong>
        <div>{t('reciprocalPairs')}: {state.quality.reciprocalPairs} · {t('hardViolations')}: {state.quality.hardViolations}</div>
        <p class={s.textMuted}>{t('qualityHelp', String(Math.round(state.quality.shortGapRatio * 100)))}</p>
        <ResponsiveDataView
          items={qualityPersons}
          getKey={person => person.personId}
          sorting={{ key: sortKey, direction: sortDirection, options: [
            { key: 'name', label: t('name') }, { key: 'presentations', label: t('presentations'), defaultDirection: 'desc' },
            { key: 'targetGapDays', label: t('targetGapDays') }, { key: 'minGapDays', label: t('minGapDays') },
            { key: 'maxGapDays', label: t('maxGapDays'), defaultDirection: 'desc' }, { key: 'gapCoefficientOfVariation', label: t('gapVariation'), defaultDirection: 'desc' },
            { key: 'shortGapRate', label: t('shortGapRate'), defaultDirection: 'desc' }, { key: 'firstWaitDays', label: t('firstWaitDays') }, { key: 'lastWaitDays', label: t('lastWaitDays') },
          ], onChange: (key, direction) => { setSortKey(key as QualitySortKey); setSortDirection(direction); } }}
          columns={[
            { header: t('name'), sortKey: 'name' }, { header: t('presentations'), sortKey: 'presentations' }, { header: t('targetGapDays'), sortKey: 'targetGapDays' },
            { header: t('minGapDays'), sortKey: 'minGapDays' }, { header: t('maxGapDays'), sortKey: 'maxGapDays' },
            { header: t('gapVariation'), sortKey: 'gapCoefficientOfVariation' }, { header: t('shortGapRate'), sortKey: 'shortGapRate' },
            { header: t('firstWaitDays'), sortKey: 'firstWaitDays' }, { header: t('lastWaitDays'), sortKey: 'lastWaitDays' },
          ]}
          renderDesktopRow={person => <>
            <td class={s.td}>{state.personNames?.[person.personId] ?? person.personId}</td>
            <td class={s.td}>{person.presentations}</td><td class={s.td}>{days(person.targetGapDays)}</td>
            <td class={s.td}>{days(person.minGapDays)}</td><td class={s.td}>{days(person.maxGapDays)}</td>
            <td class={s.td}>{person.gapCoefficientOfVariation?.toFixed(2) ?? '—'}</td>
            <td class={s.td}>{person.shortGapRate === null ? '—' : `${Math.round(person.shortGapRate * 100)}%`}</td>
            <td class={s.td}>{days(person.firstWaitDays)}</td><td class={s.td}>{days(person.lastWaitDays)}</td>
          </>}
          renderMobileCard={person => <><div class={dataStyles.mobileHeader}><div class={dataStyles.mobileTitle}>{state.personNames?.[person.personId] ?? person.personId}</div></div>
            <div class={dataStyles.mobileFields}>
              <ResponsiveDataField label={t('presentations')}>{person.presentations}</ResponsiveDataField>
              <ResponsiveDataField label={t('targetGapDays')}>{days(person.targetGapDays)}</ResponsiveDataField>
              <ResponsiveDataField label={t('minGapDays')}>{days(person.minGapDays)}</ResponsiveDataField>
              <ResponsiveDataField label={t('maxGapDays')}>{days(person.maxGapDays)}</ResponsiveDataField>
              <ResponsiveDataField label={t('gapVariation')}>{person.gapCoefficientOfVariation?.toFixed(2) ?? '—'}</ResponsiveDataField>
              <ResponsiveDataField label={t('shortGapRate')}>{person.shortGapRate === null ? '—' : `${Math.round(person.shortGapRate * 100)}%`}</ResponsiveDataField>
              <ResponsiveDataField label={t('boundaryWaitDays')}>{days(person.firstWaitDays)} / {days(person.lastWaitDays)}</ResponsiveDataField>
            </div></>}
        />
      </div>}
    </Dialog>
  );
}

interface InsertSessionDialogProps {
  open: boolean;
  title?: string;
  insertedSessionDate: string;
  minDate?: string;
  maxDate?: string;
  onInsertedDateChange: (date: string) => void;
  onApply: () => void;
  onClose: () => void;
}

export function InsertSessionDialog({
  open,
  title,
  insertedSessionDate,
  minDate,
  maxDate,
  onInsertedDateChange,
  onApply,
  onClose,
}: InsertSessionDialogProps) {
  const { t } = i18n;
  if (!open) return null;
  return (
    <Dialog open={true} onClose={onClose} title={title ?? t('insertSession')}>
      <div class={s.formGroup}>
        <label class={s.label}>{t('sessionDate')}</label>
        <input
          class={s.input}
          type="date"
          value={insertedSessionDate}
          min={minDate}
          max={maxDate}
          onInput={event => onInsertedDateChange((event.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={onApply}>{t('confirm')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Dialog>
  );
}
