import { useEffect, useMemo, useState } from 'preact/hooks';
import { getPersonSimilarity } from '@labby/core';
import type { MetricExplanation, Person, ScheduleMetrics, SimilarityLookup, SolverDiagnostics, ScheduleQualityReport } from '@labby/core';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
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

export function MetricsDialog({ state, onClose }: { state: MetricsDialogState | null; onClose: () => void }) {
  if (!state) return null;
  const { t } = i18n;
  return (
    <Dialog open={true} onClose={onClose} title={state.title}>
      {state.diagnostics && <div class={s.formGroup}>
        <strong>{t('solverSearchDiagnostics')}</strong>
        <div>{t('solverCostChange')}: {state.diagnostics.initialCost.toFixed(2)} → {state.diagnostics.finalCost.toFixed(2)}</div>
        <div>{t('solverIterations')}: {state.diagnostics.iterations} · {t('solverAccepted')}: {state.diagnostics.accepted} · {t('solverRestarts')}: {state.diagnostics.restarts}</div>
        <div>{t('solverInvalidNeighbors')}: {state.diagnostics.invalidNeighbors} · {t('solverUnchangedNeighbors')}: {state.diagnostics.unchangedNeighbors} · {state.diagnostics.durationMs} ms</div>
      </div>}
      <div class={s.formGroup}>
        {state.explanations.map(item => (
          <div key={item.key} class={`${s.text14} ${s.mb8}`}>
            <strong>{item.label}</strong>: {item.value.toFixed(3)}
            <div class={s.textMuted}>{item.summary}</div>
          </div>
        ))}
      </div>
      {state.quality && <div class={s.formGroup}>
        <strong>{t('scheduleQuality')}</strong>
        <div>{t('reciprocalPairs')}: {state.quality.reciprocalPairs} · {t('hardViolations')}: {state.quality.hardViolations}</div>
        <div style={{ overflowX: 'auto', maxHeight: '35vh' }}>
          <table class={s.table}>
            <thead><tr><th class={s.th}>{t('name')}</th><th class={s.th}>{t('presentations')}</th><th class={s.th}>{t('minGapDays')}</th><th class={s.th}>{t('maxGapDays')}</th><th class={s.th}>{t('gapVariation')}</th><th class={s.th}>{t('shortGapRate')}</th><th class={s.th}>{t('boundaryWaitDays')}</th></tr></thead>
            <tbody>{state.quality.persons.map(person => <tr key={person.personId}>
              <td class={s.td}>{state.personNames?.[person.personId] ?? person.personId}</td>
              <td class={s.td}>{person.presentations}</td>
              <td class={s.td}>{person.minGapDays?.toFixed(1) ?? '—'}</td>
              <td class={s.td}>{person.maxGapDays?.toFixed(1) ?? '—'}</td>
              <td class={s.td}>{person.gapCoefficientOfVariation?.toFixed(2) ?? '—'}</td>
              <td class={s.td}>{person.shortGapRate === null ? '—' : `${Math.round(person.shortGapRate * 100)}%`}</td>
              <td class={s.td}>{person.firstWaitDays?.toFixed(1) ?? '—'} / {person.lastWaitDays?.toFixed(1) ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>}
    </Dialog>
  );
}

interface InsertSessionDialogProps {
  open: boolean;
  insertedSessionDate: string;
  minDate?: string;
  maxDate?: string;
  onInsertedDateChange: (date: string) => void;
  onApply: () => void;
  onClose: () => void;
}

export function InsertSessionDialog({
  open,
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
    <Dialog open={true} onClose={onClose} title={t('insertSession')}>
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
