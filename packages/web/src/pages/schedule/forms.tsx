import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import type { PersonUnavailability, ScheduleConfig, SchedulePlan } from '@labby/core';

import { personsSignal } from '../store/index';
import { displayName } from '@/i18n';
import { i18n } from '@/i18n';
import * as s from '../styles/components.css';
import { Button } from '../components/ui/index';
import { Dialog } from '../components/ui/Dialog';
import { getScheduleConfigTitle } from '@/lib/scheduleConfigLabel';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface ConfigFormProps {
  initial?: ScheduleConfig;
  onSave: (c: ScheduleConfig) => void;
  onCancel: () => void;
}

export function ConfigForm({ initial, onSave, onCancel }: ConfigFormProps) {
  const { t } = i18n;
  const [title, setTitle] = useState(getScheduleConfigTitle(initial));
  const [selectedDays, setSelectedDays] = useState<number[]>(
    initial?.daysOfWeek?.length ? [...initial.daysOfWeek].sort((a, b) => a - b) : [5],
  );
  const [showDayDialog, setShowDayDialog] = useState(false);
  const [startTime, setStartTime] = useState(initial?.timeRange[0] ?? '14:00');
  const [endTime, setEndTime] = useState(initial?.timeRange[1] ?? '16:00');
  const [presenters, setPresenters] = useState(initial?.presentersPerSession ?? 3);
  const [questioners, setQuestioners] = useState(initial?.questionersPerPresenter ?? 2);
  const [radius, setRadius] = useState(initial?.targetSimilarityRadius ?? 0.5);
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');

  function handleSave() {
    if (!startDate || !endDate) return;
    if (selectedDays.length === 0) return;
    const nextMetadata: Record<string, unknown> = { ...(initial?.metadata ?? {}) };
    if (title.trim()) {
      nextMetadata.title = title.trim();
    } else {
      delete nextMetadata.title;
    }
    onSave({
      id: initial?.id ?? nanoid(),
      daysOfWeek: [...selectedDays].sort((a, b) => a - b),
      timeRange: [startTime, endTime],
      presentersPerSession: presenters,
      questionersPerPresenter: questioners,
      targetSimilarityRadius: radius,
      startDate,
      endDate,
      metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    });
  }

  function toggleDay(day: number) {
    setSelectedDays((prev) => {
      if (prev.includes(day)) {
        return prev.filter((item) => item !== day);
      }
      return [...prev, day].sort((a, b) => a - b);
    });
  }

  const selectedDayLabels = selectedDays.map((day) => DAY_NAMES[day] ?? String(day)).join(', ');

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configLabel')}</label>
        <input
          class={s.input}
          value={title}
          onInput={e => setTitle((e.target as HTMLInputElement).value)}
          placeholder={t('configLabelPlaceholder')}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configDays')}</label>
        <div class={s.flexGapSm}>
          <Button variant="secondary" onClick={() => setShowDayDialog(true)}>
            {t('selectWeekdays')}
          </Button>
          <span class={`${s.text12} ${s.textMuted}`}>{selectedDayLabels || t('noneSelected')}</span>
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configStart')}</label>
        <input class={s.input} type="date" value={startDate} onInput={e => setStartDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configEnd')}</label>
        <input class={s.input} type="date" value={endDate} onInput={e => setEndDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configTime')}</label>
        <div class={s.flexGapSm}>
          <input class={s.input} type="time" value={startTime} onInput={e => setStartTime((e.target as HTMLInputElement).value)} />
          <span class={s.textMuted}>-</span>
          <input class={s.input} type="time" value={endTime} onInput={e => setEndTime((e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configPresenters')}</label>
        <input class={s.input} type="number" min={1} value={presenters} onInput={e => setPresenters(parseInt((e.target as HTMLInputElement).value, 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configQuestioners')}</label>
        <input class={s.input} type="number" min={1} value={questioners} onInput={e => setQuestioners(parseInt((e.target as HTMLInputElement).value, 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configRadius')}</label>
        <input class={s.input} type="number" step={0.05} min={0} max={1} value={radius} onInput={e => setRadius(parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
      {showDayDialog && (
        <Dialog open={true} onClose={() => setShowDayDialog(false)} title={t('selectWeekdays')}>
          <div class={s.formGroup}>
            <div class={s.tagList}>
              {DAY_NAMES.map((dayName, dayIndex) => (
                <button
                  key={dayIndex}
                  class={`${s.badgeSelectable} ${selectedDays.includes(dayIndex) ? s.badgeSelectableActive : ''}`}
                  onClick={() => toggleDay(dayIndex)}
                >
                  {dayName}
                </button>
              ))}
            </div>
            <div class={`${s.text12} ${s.textMuted}`}>
              {selectedDayLabels || t('noneSelected')}
            </div>
          </div>
          <div class={s.flexGapSm}>
            <Button variant="primary" onClick={() => setShowDayDialog(false)}>{t('confirm')}</Button>
            <Button variant="secondary" onClick={() => setShowDayDialog(false)}>{t('cancel')}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

interface UnavailFormProps {
  configId: string;
  onSave: (u: PersonUnavailability) => void;
  onCancel: () => void;
}

export function UnavailForm({ configId, onSave, onCancel }: UnavailFormProps) {
  const { t } = i18n;
  const persons = personsSignal.value;
  const [personId, setPersonId] = useState(persons[0]?.id ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  function handleSave() {
    if (!personId || !startDate || !endDate) return;
    onSave({ id: nanoid(), personId, configId, startDate, endDate });
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailPerson')}</label>
        <select class={s.input} value={personId} onChange={e => setPersonId((e.target as HTMLSelectElement).value)}>
          {persons.map(p => <option key={p.id} value={p.id}>{displayName(p)}</option>)}
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailStart')}</label>
        <input class={s.input} type="date" value={startDate} onInput={e => setStartDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailEnd')}</label>
        <input class={s.input} type="date" value={endDate} onInput={e => setEndDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

interface HistoryNotesDialogProps {
  plan: SchedulePlan;
  onSave: (notes: string) => void;
  onClose: () => void;
}

export function HistoryNotesDialog({ plan, onSave, onClose }: HistoryNotesDialogProps) {
  const { t } = i18n;
  const [notes, setNotes] = useState(plan.notes ?? '');
  return (
    <Dialog open={true} onClose={onClose} title={t('historyNotes')}>
      <div class={s.formGroup}>
        <textarea
          class={s.input}
          rows={4}
          value={notes}
          onInput={e => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => { onSave(notes); onClose(); }}>{t('save')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Dialog>
  );
}
