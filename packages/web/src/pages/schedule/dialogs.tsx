import { useState } from 'preact/hooks';
import {
  personsSignal,
  currentScheduleSignal,
  similarityMapSignal,
  personMapSignal,
} from '@/store/index';
import { displayName } from '@/i18n';
import { loadAllSchedules, useDatabase } from '@/db/index';
import type {
  SchedulePlan,
  Session,
  Presentation,
  MetricExplanation,
  ScheduleMetrics,
} from '@labby/core';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
import { Dialog } from '@/components/ui/Dialog';
import { i18n } from '@/i18n';

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

export function ManualEditDialog({ mode, sessionDate, presIndex, questIndex, onClose }: ManualEditDialogProps) {
  const { t } = i18n;
  const persons = personsSignal.value.filter(p => !p.disabled);
  const current = currentScheduleSignal.value;
  const simMap = similarityMapSignal.value;
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
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    return simMap.get(`${a}|${b}`) ?? 0;
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
                <td class={s.td}>{similarity(p.id, pres.presenterId).toFixed(3)}</td>
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
  onInsertedDateChange: (date: string) => void;
  onInsertPositionChange: (pos: 'before' | 'after') => void;
  onApply: () => void;
  onClose: () => void;
}

export function SessionMutationDialog({
  state,
  insertedSessionDate,
  insertPosition,
  onInsertedDateChange,
  onInsertPositionChange,
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
              onInput={e => onInsertedDateChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('mutationInsertPosition')}</label>
            <select
              class={s.input}
              value={insertPosition}
              onChange={e => onInsertPositionChange((e.target as HTMLSelectElement).value as 'before' | 'after')}
            >
              <option value="before">{t('mutationBefore')}</option>
              <option value="after">{t('mutationAfter')}</option>
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