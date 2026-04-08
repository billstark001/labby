import { useState } from 'preact/hooks';
import {
  personsSignal,
  currentScheduleSignal,
  similarityLookupSignal,
  personMapSignal,
} from '@/store/index';
import { displayName } from '@/i18n';
import { loadAllSchedules, useDatabase } from '@/db/index';
import {
  type SchedulePlan,
  type Session,
  type Presentation,
  type MetricExplanation,
  type ScheduleMetrics,
  getPersonSimilarity,
} from '@labby/core';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
import { Dialog } from '@/components/ui/Dialog';
import { i18n } from '@/i18n';
import { computed } from '@preact/signals';

// #region Shared types

export interface MetricsDialogState {
  title: string;
  metrics: ScheduleMetrics;
  explanations: MetricExplanation[];
}

export interface SessionMutationDialogState {
  mode: 'insert' | 'delete';
  sessionDate: string;
}

// #endregion

// #region ManualEditDialog

export interface ManualEditDialogProps {
  mode: 'presenter' | 'questioner';
  sessionDate: string;
  presIndex: number;
  questIndex?: number;
  onClose: () => void;
}

const personKeywordsLookup = computed(() => {
  const m = new Map<string, string[]>();
  for (const p of personsSignal.value) {
    m.set(p.id, p.keywordIds);
  }
  return m;
});

export function ManualEditDialog({ mode, sessionDate, presIndex, questIndex, onClose }: ManualEditDialogProps) {
  const { t } = i18n;
  const persons = personsSignal.value.filter(p => !p.disabled);
  const personKeywords = personKeywordsLookup.value;
  const current = currentScheduleSignal.value;
  const simLookup = similarityLookupSignal.value; // TODO, BUG: this is keyword similarity, not person similarity, so it only returns 0 for id missing!
  const personMap = personMapSignal.value;
  const db = useDatabase();

  if (!current) return null;
  const session = current.sessions.find(s => s.date === sessionDate);
  if (!session) return null;
  const pres = session.presentations[presIndex];
  if (!pres) return null;

  const currentId = mode === 'presenter' ? pres.presenterId : pres.questionerIds[questIndex ?? 0];
  const presenterPerson = personMap.get(pres.presenterId);

  function similarity(aId: string, bId: string): number {
    if (aId === bId) return 1;
    return getPersonSimilarity(
      personKeywords.get(aId) ?? [],
      personKeywords.get(bId) ?? [],
      simLookup,
    );
  }

  function handleSelect(newId: string) {
    if (!current) return;
    const newSessions: Session[] = current.sessions.map(sess => {
      if (sess.date !== sessionDate) return sess;
      const newPresentations: Presentation[] = sess.presentations.map((p, pi) => {
        if (pi !== presIndex) return p;
        if (mode === 'presenter') return { ...p, presenterId: newId };
        const newQIds = [...p.questionerIds];
        newQIds[questIndex ?? 0] = newId;
        return { ...p, questionerIds: newQIds };
      });
      return { ...sess, presentations: newPresentations };
    });
    const updated: SchedulePlan = { ...current, sessions: newSessions, modifiedAt: Date.now() };
    db.schedules.put(updated).then(async () => {
      await loadAllSchedules(db);
      currentScheduleSignal.value = updated;
    });
    onClose();
  }

  const similarities: Map<string, number> = new Map();
  if (mode === 'questioner' && presenterPerson) {
    for (const p of persons) {
      similarities.set(p.id, similarity(p.id, pres.presenterId));
    }
  }

  const getCellColor = (pId: string): string => {
    if (pId === currentId) return 'inherit';
    if (mode !== 'questioner' || !presenterPerson) return 'inherit';
    const sim = similarities.get(pId) ?? 0;
    if (sim >= 1) return '#4caf50'; // exact match, use solid green
    if (sim >= 0.75) return 'green';
    if (sim >= 0.5) return '#b7c34a';
    if (sim >= 0.25) return 'orange';
    if (sim >= 0) return 'red';
    return 'inherit';
  }

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={mode === 'presenter' ? t('selectNewPresenter') : t('selectNewQuestioner')}
    >
      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{t('name')}</th>
            {mode === 'questioner' && presenterPerson && <th class={s.th}>{t('similarity')}</th>}
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {persons.map(p => (
            <tr key={p.id} style={{ opacity: p.id === currentId ? 0.4 : 1 }}>
              <td class={s.td}>{displayName(p)}</td>
              {mode === 'questioner' && presenterPerson && (
                <td class={s.td} style={{ color: getCellColor(p.id) }}>{similarities.get(p.id)?.toFixed(3)}</td>
              )}
              <td class={s.td}>
                <Button
                  variant={p.id === currentId ? 'ghost' : 'primary'}
                  onClick={() => handleSelect(p.id)}
                  disabled={p.id === currentId}
                >
                  {t('confirm')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

// #endregion

// #region MetricsDialog

export interface MetricsDialogProps {
  state: MetricsDialogState | null;
  onClose: () => void;
}

export function MetricsDialog({ state, onClose }: MetricsDialogProps) {
  if (!state) return null;
  return (
    <Dialog open={true} onClose={onClose} title={state.title}>
      <div class={s.formGroup}>
        {state.explanations.map(item => (
          <div key={item.key} class={`${s.text14} ${s.mb8}`}>
            <strong>{item.label}</strong>: {item.value.toFixed(3)}
            <div class={s.textMuted}>{item.summary}</div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// #endregion

// #region SessionMutationDialog

export interface SessionMutationDialogProps {
  state: SessionMutationDialogState | null;
  insertedSessionDate: string;
  insertPosition: 'before' | 'after';
  tactic: 'shift' | 'keep';
  count: number;
  minDate?: string;
  maxDate?: string;
  onInsertedDateChange: (date: string) => void;
  onInsertPositionChange: (pos: 'before' | 'after') => void;
  onTacticChange: (tactic: 'shift' | 'keep') => void;
  onCountChange: (count: number) => void;
  onApply: () => void;
  onClose: () => void;
}

export function SessionMutationDialog({
  state,
  insertedSessionDate,
  insertPosition,
  tactic,
  count,
  minDate,
  maxDate,
  onInsertedDateChange,
  onInsertPositionChange,
  onTacticChange,
  onCountChange,
  onApply,
  onClose,
}: SessionMutationDialogProps) {
  const { t } = i18n;
  if (!state) return null;

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={state.mode === 'insert' ? t('mutationInsertDialogTitle') : t('mutationDeleteDialogTitle')}
    >
      <div class={s.formGroup}>
        <label class={s.label}>{t('sessionDate')}</label>
        <input class={s.input} value={state.sessionDate} disabled />
      </div>
      {state.mode === 'insert' && (
        <>
          <div class={s.formGroup}>
            <label class={s.label}>{t('mutationInsertedDate')}</label>
            <input
              class={s.input}
              type="date"
              value={insertedSessionDate}
              min={minDate}
              max={maxDate}
              onInput={e => onInsertedDateChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>Strategy</label>
            <select
              class={s.input}
              value={tactic}
              onChange={e => onTacticChange((e.target as HTMLSelectElement).value as 'shift' | 'keep')}
            >
              <option value="keep">{t('mutationStrategyInPlace')}</option>
              <option value="shift">{t('mutationStrategyShift')}</option>
            </select>
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('mutationInsertPosition')}</label>
            <select
              class={s.input}
              value={insertPosition}
              disabled={tactic === 'shift'}
              onChange={e => onInsertPositionChange((e.target as HTMLSelectElement).value as 'before' | 'after')}
            >
              <option value="before">{t('mutationBefore')}</option>
              <option value="after">{t('mutationAfter')}</option>
            </select>
          </div>
        </>
      )}
      {state.mode === 'delete' && (
        <>
          <div class={s.formGroup}>
            <label class={s.label}>Count</label>
            <input
              class={s.input}
              type="number"
              min={1}
              step={1}
              value={count}
              onInput={e => onCountChange(Math.max(1, Number((e.target as HTMLInputElement).value || 1)))}
            />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>Strategy</label>
            <select
              class={s.input}
              value={tactic}
              onChange={e => onTacticChange((e.target as HTMLSelectElement).value as 'shift' | 'keep')}
            >
              <option value="keep">{t('mutationStrategyInPlace')}</option>
              <option value="shift">{t('mutationStrategyShift')}</option>
            </select>
          </div>
        </>
      )}
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={onApply}>{t('applyMutation')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Dialog>
  );
}

// #endregion

// #region PresentationMutationDialog

export interface PresentationMutationDialogState {
  sessionDate: string;
  presentationIndex: number;
}

export interface PresentationMutationDialogProps {
  state: PresentationMutationDialogState | null;
  operation: 'insert' | 'delete';
  count: number;
  mode: 'session-resize' | 'shift-chain' | 'session-refill';
  onOperationChange: (operation: 'insert' | 'delete') => void;
  onCountChange: (count: number) => void;
  onModeChange: (mode: 'session-resize' | 'shift-chain' | 'session-refill') => void;
  onApply: () => void;
  onClose: () => void;
}

export function PresentationMutationDialog({
  state,
  operation,
  count,
  mode,
  onOperationChange,
  onCountChange,
  onModeChange,
  onApply,
  onClose,
}: PresentationMutationDialogProps) {
  const { t } = i18n;
  if (!state) return null;

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Edit Presentation Mutation"
    >
      <div class={s.formGroup}>
        <label class={s.label}>{t('sessionDate')}</label>
        <input class={s.input} value={state.sessionDate} disabled />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Presentation Index</label>
        <input class={s.input} value={String(state.presentationIndex + 1)} disabled />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Operation</label>
        <select
          class={s.input}
          value={operation}
          onChange={e => onOperationChange((e.target as HTMLSelectElement).value as 'insert' | 'delete')}
        >
          <option value="insert">{t('mutationInsert')}</option>
          <option value="delete">{t('mutationDelete')}</option>
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Count</label>
        <input
          class={s.input}
          type="number"
          min={1}
          step={1}
          value={count}
          onInput={e => onCountChange(Math.max(1, Number((e.target as HTMLInputElement).value || 1)))}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>Mode</label>
        <select
          class={s.input}
          value={mode}
          onChange={e => onModeChange((e.target as HTMLSelectElement).value as 'session-resize' | 'shift-chain' | 'session-refill')}
        >
          <option value="session-resize">Resize Current Session</option>
          <option value="shift-chain">Shift Across Sessions</option>
          <option value="session-refill">Refill Current Session</option>
        </select>
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={onApply}>{t('applyMutation')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Dialog>
  );
}

// #endregion