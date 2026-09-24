import { useState } from 'preact/hooks';
import type { GapBalancePolicy, PersonUnavailability, ScheduleConfig, SchedulePlan } from '@labby/core';
import { DEFAULT_GAP_BALANCE, SYSTEM_DEFAULT_TIMEZONE } from '@labby/core';

import { personsSignal } from '@/store/index';
import { displayName } from '@/i18n';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
import { Dialog } from '@/components/ui/Dialog';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { getScheduleConfigTitle } from '@/lib/scheduleConfigLabel';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface ConfigFormProps {
  initial?: ScheduleConfig;
  onSave: (c: ScheduleConfig) => Promise<void>;
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
  const [gapBalance, setGapBalance] = useState<Record<'presenter' | 'questioner', GapBalancePolicy>>({
    presenter: { ...DEFAULT_GAP_BALANCE.presenter, ...initial?.gapBalance?.presenter },
    questioner: { ...DEFAULT_GAP_BALANCE.questioner, ...initial?.gapBalance?.questioner },
  });
  const [reciprocalPairPreference, setReciprocalPairPreference] = useState<NonNullable<ScheduleConfig['reciprocalPairPreference']>>(
    initial?.reciprocalPairPreference ?? 'neutral',
  );
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [timezone, setTimezone] = useState(initial?.timezone ?? SYSTEM_DEFAULT_TIMEZONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!startDate || !endDate) return;
    if (selectedDays.length === 0) return;
    const nextMetadata: Record<string, unknown> = { ...(initial?.metadata ?? {}) };
    if (title.trim()) {
      nextMetadata.title = title.trim();
    } else {
      delete nextMetadata.title;
    }
    setSaving(true);
    setError(null);
    try { await onSave({
      id: initial?.id ?? crypto.randomUUID(),
      daysOfWeek: [...selectedDays].sort((a, b) => a - b),
      timeRange: [startTime, endTime],
      presentersPerSession: presenters,
      questionersPerPresenter: questioners,
      targetSimilarityRadius: radius,
      gapBalance,
      reciprocalPairPreference,
      startDate,
      endDate,
      timezone: timezone === SYSTEM_DEFAULT_TIMEZONE ? undefined : timezone,
      metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    }); } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
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
  function setGapValue(role: 'presenter' | 'questioner', key: keyof GapBalancePolicy, raw: string, divisor = 1) {
    const parsed = Number(raw) / divisor;
    const maximum = key === 'shortGapRatio' ? 1 : key === 'shortGapWeight' ? 100 : 50;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum)
      setGapBalance(previous => ({ ...previous, [role]: { ...previous[role], [key]: parsed } }));
  }

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
        <label class={s.label}>{t('scheduleTimezone')}</label>
        <TimezoneSelect
          value={timezone}
          defaultLabel={t('scheduleTimezoneDefault')}
          onChange={setTimezone}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configPresenters')}</label>
        <input class={s.input} type="number" min={1} value={presenters} onInput={e => setPresenters(parseInt((e.target as HTMLInputElement).value, 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configQuestioners')}</label>
        <input class={s.input} type="number" min={0} value={questioners} onInput={e => setQuestioners(parseInt((e.target as HTMLInputElement).value || '0', 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configRadius')}</label>
        <input class={s.input} type="number" step={0.05} min={0} max={1} value={radius} onInput={e => setRadius(parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('reciprocalPairPreference')}</label>
        <select class={s.input} value={reciprocalPairPreference} onChange={event =>
          setReciprocalPairPreference((event.target as HTMLSelectElement).value as NonNullable<ScheduleConfig['reciprocalPairPreference']>)}>
          <option value="forbid">{t('reciprocalForbid')}</option>
          <option value="discourage">{t('reciprocalDiscourage')}</option>
          <option value="neutral">{t('reciprocalNeutral')}</option>
          <option value="encourage">{t('reciprocalEncourage')}</option>
        </select>
      </div>
      <details style={{ marginBottom: '1rem' }}>
        <summary style={{ cursor: 'pointer' }}>{t('gapBalanceSettings')}</summary>
        <p class={s.mutedParagraph}>{t('gapBalanceHelp')}</p>
        {(['presenter', 'questioner'] as const).map(role => <fieldset key={role} style={{ border: 'none', marginBottom: '1rem' }}>
          <legend class={s.label} style={{ marginBottom: '0.5rem' }}>{t(role === 'presenter' ? 'gapBalancePresenter' : 'gapBalanceQuestioner')}</legend>
          <div class={s.formGroup}>
            <label class={s.label}>{t('gapBalanceShortRatio')}</label>
            <input class={s.input} type="number" min={0} max={100} step={1} value={Math.round(gapBalance[role].shortGapRatio * 100)}
              onInput={event => setGapValue(role, 'shortGapRatio', (event.target as HTMLInputElement).value, 100)} />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('gapBalanceShortWeight')}</label>
            <input class={s.input} type="number" min={0} max={100} step={1} value={gapBalance[role].shortGapWeight}
              onInput={event => setGapValue(role, 'shortGapWeight', (event.target as HTMLInputElement).value)} />
          </div>
          <div class={s.formGroup}>
            <label class={s.label}>{t('gapBalanceSpreadWeight')}</label>
            <input class={s.input} type="number" min={0} max={50} step={1} value={gapBalance[role].spreadWeight}
              onInput={event => setGapValue(role, 'spreadWeight', (event.target as HTMLInputElement).value)} />
          </div>
        </fieldset>)}
      </details>
      <div class={s.flexGapSm}>
        <Button variant="primary" busy={saving} onClick={() => void handleSave()}>{t('save')}</Button>
        <Button variant="secondary" disabled={saving} onClick={onCancel}>{t('cancel')}</Button>
      </div>
      {error && <p role="alert" class={s.textDanger}>{error}</p>}
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
  initial?: PersonUnavailability;
  onSave: (u: PersonUnavailability) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}

export function UnavailForm({ configId, initial, onSave, onCancel, onDelete }: UnavailFormProps) {
  const { t } = i18n;
  const persons = personsSignal.value;
  const [personIds, setPersonIds] = useState<string[]>(() => {
    if (Array.isArray(initial?.personIds) && initial.personIds.length > 0) {
      return [...new Set(initial.personIds)];
    }
    if (initial?.personId) {
      return [initial.personId];
    }
    return [];
  });
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (personIds.length === 0 || !startDate || !endDate) return;
    setSaving(true);
    setError(null);
    try { await onSave({
      id: initial?.id ?? crypto.randomUUID(),
      personId: personIds[0],
      personIds,
      configId,
      startDate,
      endDate,
    }); } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  }

  function togglePerson(personId: string) {
    setPersonIds((prev) => {
      if (prev.includes(personId)) {
        return prev.filter((id) => id !== personId);
      }
      return [...prev, personId];
    });
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailPerson')}</label>
        <div class={s.tagList}>
          {persons.map((person) => {
            const selected = personIds.includes(person.id);
            return (
              <button
                key={person.id}
                type="button"
                class={`${s.badgeSelectable} ${selected ? s.badgeSelectableActive : ''}`}
                onClick={() => togglePerson(person.id)}
              >
                {displayName(person)}
              </button>
            );
          })}
        </div>
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
        <Button variant="primary" busy={saving} onClick={() => void handleSave()}>{t('save')}</Button>
        <Button variant="secondary" disabled={saving} onClick={onCancel}>{t('cancel')}</Button>
        {onDelete && <Button variant="danger" disabled={saving} onClick={onDelete}>{t('delete')}</Button>}
      </div>
      {error && <p role="alert" class={s.textDanger}>{error}</p>}
    </div>
  );
}

interface HistoryNotesDialogProps {
  plan: SchedulePlan;
  onSave: (notes: string) => Promise<void>;
  onClose: () => void;
}

export function HistoryNotesDialog({ plan, onSave, onClose }: HistoryNotesDialogProps) {
  const { t } = i18n;
  const [notes, setNotes] = useState(plan.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function saveNotes() {
    setSaving(true);
    setError(null);
    try { await onSave(notes); onClose(); }
    catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  }
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
        <Button variant="primary" busy={saving} onClick={() => void saveNotes()}>{t('save')}</Button>
        <Button variant="secondary" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
      </div>
      {error && <p role="alert" class={s.textDanger}>{error}</p>}
    </Dialog>
  );
}
