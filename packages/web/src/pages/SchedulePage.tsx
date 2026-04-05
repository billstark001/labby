/** Schedule configuration form and schedule view. */
import { useEffect, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { Calendar, X, Pencil } from 'lucide-preact';
import {
  personsSignal,
  configsSignal,
  constraintsSignal,
  schedulesSignal,
  currentScheduleSignal,
  similarityMapSignal,
  isComputingSignal,
  personMapSignal,
  unavailabilitiesSignal,
} from '../store/index';
import { fallbackEntityId, displayName } from '@/i18n';
import {
  loadAllConfigs,
  loadAllConstraints,
  loadAllEmailTasks,
  loadAllPersons,
  loadAllSchedules,
  loadAllSimilarities,
  loadAllUnavailabilities,
  useDatabase,
} from '../db/index';
import { computeScheduleMetrics, explainScheduleMetrics, solveFull, solveIncremental } from '@labby/core';
import type { ScheduleConfig, SchedulePlan, PersonUnavailability, Session, Presentation, MetricExplanation, ScheduleMetrics } from '@labby/core';
import * as s from '../styles/components.css';
import {
  Button,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '../components/ui/index';
import {
  copyScheduleTable,
  copyScheduleHtml,
  copyScheduleCsv,
  downloadScheduleCsv,
  downloadScheduleHtml,
  downloadScheduleIcs,
} from '../lib/scheduleExport';
import { Dialog, confirmDialog } from '../components/ui/Dialog';
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from '../components/ui/Menu';
import { toast } from '../components/ui/Toast';
import { apiClient } from '@/lib/api';
import { isServerDeployment } from '@/lib/runtime';
import { i18n } from '@/i18n';
import { getScheduleConfigLabel, getScheduleConfigSummary, getScheduleConfigTitle } from '@/lib/scheduleConfigLabel';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LAST_SELECTED_CONFIG_STORAGE_KEY = 'schedule.lastSelectedConfigId';

// ---------------------------------------------------------------------------
// Config form
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial?: ScheduleConfig;
  onSave: (c: ScheduleConfig) => void;
  onCancel: () => void;
}

function ConfigForm({ initial, onSave, onCancel }: ConfigFormProps) {
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
          <span class={s.textMuted}>–</span>
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

// ---------------------------------------------------------------------------
// PersonUnavailability form
// ---------------------------------------------------------------------------

interface UnavailFormProps {
  configId: string;
  onSave: (u: PersonUnavailability) => void;
  onCancel: () => void;
}

function UnavailForm({ configId, onSave, onCancel }: UnavailFormProps) {
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

// ---------------------------------------------------------------------------
// HistoryNotesDialog
// ---------------------------------------------------------------------------

interface HistoryNotesDialogProps {
  plan: SchedulePlan;
  onSave: (notes: string) => void;
  onClose: () => void;
}

function HistoryNotesDialog({ plan, onSave, onClose }: HistoryNotesDialogProps) {
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

// ---------------------------------------------------------------------------
// ManualEditDialog – select replacement presenter or questioner
// ---------------------------------------------------------------------------

interface ManualEditDialogProps {
  mode: 'presenter' | 'questioner';
  sessionDate: string;
  presIndex: number;
  questIndex?: number; // only for questioner mode
  onClose: () => void;
}

interface MetricsDialogState {
  title: string;
  metrics: ScheduleMetrics;
  explanations: MetricExplanation[];
}

interface SessionMutationDialogState {
  mode: 'insert' | 'delete';
  sessionDate: string;
}

function defaultIncrementalDate(): string {
  const nextWeek = new Date();
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  return nextWeek.toISOString().slice(0, 10);
}

function normalizeSolveResponse(result: unknown): {
  plan: SchedulePlan;
  metrics?: ScheduleMetrics;
  explanations?: MetricExplanation[];
  warnings?: string[];
} {
  if (result && typeof result === 'object' && 'plan' in (result as Record<string, unknown>)) {
    const wrapped = result as {
      plan: SchedulePlan;
      metrics?: ScheduleMetrics;
      explanations?: MetricExplanation[];
      warnings?: string[];
    };
    return wrapped;
  }
  return { plan: result as SchedulePlan };
}

function ManualEditDialog({ mode, sessionDate, presIndex, questIndex, onClose }: ManualEditDialogProps) {
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

  function similarity(aId: string, bId: string): number {
    if (aId === bId) return 1;
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    return simMap.get(`${a}|${b}`) ?? 0;
  }

  const presenterPerson = personMap.get(pres.presenterId);

  function handleSelect(newId: string) {
    if (!current) return;
    const newSessions: Session[] = current.sessions.map(sess => {
      if (sess.date !== sessionDate) return sess;
      const newPresentations: Presentation[] = sess.presentations.map((p, pi) => {
        if (pi !== presIndex) return p;
        if (mode === 'presenter') {
          return { ...p, presenterId: newId };
        } else {
          const newQIds = [...p.questionerIds];
          newQIds[questIndex ?? 0] = newId;
          return { ...p, questionerIds: newQIds };
        }
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
            {mode === 'questioner' && presenterPerson && (
              <th class={s.th}>{t('similarity')}</th>
            )}
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

// ---------------------------------------------------------------------------
// SchedulePage
// ---------------------------------------------------------------------------

export function SchedulePage() {
  const { t } = i18n;
  const configs = configsSignal.value;
  const persons = personsSignal.value;
  const schedules = schedulesSignal.value;
  const current = currentScheduleSignal.value;
  const isComputing = isComputingSignal.value;
  const unavailabilities = unavailabilitiesSignal.value;
  const db = useDatabase();

  const [showConfigForm, setShowConfigForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ScheduleConfig | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [changeDate, setChangeDate] = useState('');
  const [copiedTsv, setCopiedTsv] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedCsv, setCopiedCsv] = useState(false);
  const [showUnavailForm, setShowUnavailForm] = useState(false);
  const [editingNotes, setEditingNotes] = useState<SchedulePlan | null>(null);
  const [manualEditTarget, setManualEditTarget] = useState<{
    mode: 'presenter' | 'questioner';
    sessionDate: string;
    presIndex: number;
    questIndex?: number;
  } | null>(null);
  const [manualEditMode, setManualEditMode] = useState(false);
  const [metricsDialog, setMetricsDialog] = useState<MetricsDialogState | null>(null);
  const [sessionMutationDialog, setSessionMutationDialog] = useState<SessionMutationDialogState | null>(null);
  const [insertedSessionDate, setInsertedSessionDate] = useState('');
  const [insertPosition, setInsertPosition] = useState<'before' | 'after'>('after');
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());

  const activePersonCount = persons.filter(p => !p.disabled).length;
  const selectedConfig = configs.find(c => c.id === selectedConfigId);
  const schedulesForSelectedConfig = selectedConfigId
    ? schedules.filter((item) => item.configId === selectedConfigId)
    : [];
  const personMap = personMapSignal.value;

  // Unavailabilities scoped to the selected config
  const configUnavails = unavailabilities.filter(u => u.configId === selectedConfigId);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await Promise.all([
        loadAllPersons(db),
        loadAllConfigs(db),
        loadAllConstraints(db),
        loadAllSchedules(db),
        loadAllSimilarities(db),
        loadAllUnavailabilities(db),
        loadAllEmailTasks(db),
      ]);
      if (cancelled) return;
      const remembered = localStorage.getItem(LAST_SELECTED_CONFIG_STORAGE_KEY) ?? '';
      if (remembered && configsSignal.value.some((item) => item.id === remembered)) {
        setSelectedConfigId(remembered);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    if (selectedConfigId && !configs.some((item) => item.id === selectedConfigId)) {
      setSelectedConfigId('');
      localStorage.removeItem(LAST_SELECTED_CONFIG_STORAGE_KEY);
    }
  }, [configs, selectedConfigId]);

  useEffect(() => {
    if (!selectedConfigId) {
      currentScheduleSignal.value = null;
      setSelectedHistoryIds(new Set());
      return;
    }
    localStorage.setItem(LAST_SELECTED_CONFIG_STORAGE_KEY, selectedConfigId);
    const currentPlan = currentScheduleSignal.value;
    if (!currentPlan || currentPlan.configId !== selectedConfigId) {
      const latest = schedulesForSelectedConfig.reduce<SchedulePlan | null>((acc, item) => {
        if (!acc || item.createdAt > acc.createdAt) return item;
        return acc;
      }, null);
      currentScheduleSignal.value = latest;
    }
    setSelectedHistoryIds(new Set());
  }, [selectedConfigId, schedulesForSelectedConfig]);

  useEffect(() => {
    if (!changeDate) {
      setChangeDate(defaultIncrementalDate());
    }
  }, [changeDate]);

  function openMetricsDialog(title: string, metrics: ScheduleMetrics, explanations: MetricExplanation[]) {
    setMetricsDialog({ title, metrics, explanations });
  }

  function localMetricsForPlan(plan: SchedulePlan): { metrics: ScheduleMetrics; explanations: MetricExplanation[] } | null {
    const config = configs.find(c => c.id === plan.configId);
    if (!config) return null;
    const constraints = constraintsSignal.value.filter(item => !item.configId || item.configId === config.id);
    const metrics = computeScheduleMetrics(plan, {
      persons,
      similarities: similarityMapSignal.value,
      config,
      unavailabilities,
      constraints,
    });
    return { metrics, explanations: explainScheduleMetrics(metrics) };
  }

  async function showMetricsForPlan(plan: SchedulePlan): Promise<void> {
    if (isServerDeployment) {
      const data = await apiClient.request<{ metrics: ScheduleMetrics; explanations: MetricExplanation[] }>('/solver/metrics', {
        method: 'POST',
        body: JSON.stringify({ scheduleId: plan.id }),
      });
      openMetricsDialog(`${t('historyTitle')} · ${new Date(plan.createdAt).toLocaleString()}`, data.metrics, data.explanations);
      return;
    }
    const local = localMetricsForPlan(plan);
    if (local) {
      openMetricsDialog(`${t('historyTitle')} · ${new Date(plan.createdAt).toLocaleString()}`, local.metrics, local.explanations);
    }
  }

  async function showMetricsForSession(plan: SchedulePlan, sessionDate: string): Promise<void> {
    if (isServerDeployment) {
      const data = await apiClient.request<{ metrics: ScheduleMetrics; explanations: MetricExplanation[] }>('/solver/metrics', {
        method: 'POST',
        body: JSON.stringify({ scheduleId: plan.id, sessionDate }),
      });
      openMetricsDialog(`${sessionDate} · ${t('sessionDate')}`, data.metrics, data.explanations);
      return;
    }

    const config = configs.find(c => c.id === plan.configId);
    if (!config) return;
    const constraints = constraintsSignal.value.filter(item => !item.configId || item.configId === config.id);
    const sessionIndex = plan.sessions.findIndex((session) => session.date === sessionDate);
    if (sessionIndex < 0) return;
    const metrics = computeScheduleMetrics({ ...plan, sessions: [plan.sessions[sessionIndex]] }, {
      persons,
      similarities: similarityMapSignal.value,
      config,
      unavailabilities,
      constraints,
    }, plan.sessions.slice(0, sessionIndex));
    openMetricsDialog(`${sessionDate} · ${t('sessionDate')}`, metrics, explainScheduleMetrics(metrics));
  }

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put({ ...c, modifiedAt: Date.now() });
    await loadAllConfigs(db);
    setShowConfigForm(false);
    setEditingConfig(null);
    if (!selectedConfigId) setSelectedConfigId(c.id);
  }

  async function handleGenerate() {
    const config = configs.find(c => c.id === selectedConfigId);
    if (!config || activePersonCount === 0) return;
    const suggested = defaultIncrementalDate();
    if (config.startDate < suggested) {
      const proceed = window.confirm(t('rescheduleDateEarlyWarning'));
      if (!proceed) return;
    }
    const constraints = constraintsSignal.value.filter(item => !item.configId || item.configId === config.id);
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const result = isServerDeployment
        ? await apiClient.request<unknown>('/solver/run', {
          method: 'POST',
          body: JSON.stringify({
            configId: config.id,
            personIds: persons.map((p) => p.id),
          }),
        })
        : solveFull({
          persons,
          similarities: similarityMapSignal.value,
          config,
          unavailabilities,
          constraints,
        });
      const normalized = normalizeSolveResponse(result);
      const plan = normalized.plan;
      await db.schedules.put({ ...plan, modifiedAt: Date.now() });
      await loadAllSchedules(db);
      currentScheduleSignal.value = { ...plan, modifiedAt: Date.now() };
      if (normalized.metrics && normalized.explanations) {
        openMetricsDialog(t('metricsAfterComputeTitle'), normalized.metrics, normalized.explanations);
      } else {
        const local = localMetricsForPlan(plan);
        if (local) openMetricsDialog(t('metricsAfterComputeTitle'), local.metrics, local.explanations);
      }
      toast.dismiss(tid);
      toast.success(t('computeSuccess'));
    } catch (err) {
      toast.dismiss(tid);
      toast.error(`${t('computeError')}: ${String(err)}`);
    } finally {
      isComputingSignal.value = false;
    }
  }

  async function handleIncremental() {
    if (!current || !changeDate) return;
    const config = configs.find(c => c.id === current.configId);
    if (!config) return;
    const constraints = constraintsSignal.value.filter(item => !item.configId || item.configId === config.id);
    const suggested = defaultIncrementalDate();
    if (changeDate < suggested) {
      const proceed = window.confirm(t('rescheduleDateEarlyWarning'));
      if (!proceed) return;
    }
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const result = isServerDeployment
        ? await apiClient.request<unknown>('/solver/run-incremental', {
          method: 'POST',
          body: JSON.stringify({
            configId: config.id,
            previousPlanId: current.id,
            changeDate,
            personIds: persons.map((p) => p.id),
          }),
        })
        : solveIncremental({
          persons,
          similarities: similarityMapSignal.value,
          config,
          previousPlan: current,
          changeDate,
          unavailabilities,
          constraints,
        });
      const normalized = normalizeSolveResponse(result);
      const plan = normalized.plan;
      await db.schedules.put({ ...plan, modifiedAt: Date.now() });
      await loadAllSchedules(db);
      currentScheduleSignal.value = { ...plan, modifiedAt: Date.now() };
      if (normalized.warnings?.length) {
        window.alert(normalized.warnings.join('\n'));
      }
      if (normalized.metrics && normalized.explanations) {
        openMetricsDialog(t('metricsAfterComputeTitle'), normalized.metrics, normalized.explanations);
      } else {
        const local = localMetricsForPlan(plan);
        if (local) openMetricsDialog(t('metricsAfterComputeTitle'), local.metrics, local.explanations);
      }
      toast.dismiss(tid);
      toast.success(t('computeSuccess'));
    } catch (err) {
      toast.dismiss(tid);
      toast.error(`${t('computeError')}: ${String(err)}`);
    } finally {
      isComputingSignal.value = false;
    }
  }

  async function handleCopyTsv() {
    if (!current) return;
    await copyScheduleTable(current, personMap, displayName);
    setCopiedTsv(true);
    window.setTimeout(() => setCopiedTsv(false), 1500);
  }

  async function handleCopyHtml() {
    if (!current) return;
    await copyScheduleHtml(current, personMap, displayName);
    setCopiedHtml(true);
    window.setTimeout(() => setCopiedHtml(false), 1500);
  }

  async function handleCopyCsv() {
    if (!current) return;
    await copyScheduleCsv(current, personMap, displayName);
    setCopiedCsv(true);
    window.setTimeout(() => setCopiedCsv(false), 1500);
  }

  function handleExportIcs() {
    if (!current) return;
    const config = configs.find(c => c.id === current.configId);
    downloadScheduleIcs(current, personMap, displayName, config, {
      presenter: t('presenter'),
      questioners: t('questioners'),
    });
  }

  async function handleDeleteHistory(plan: SchedulePlan) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.schedules.delete(plan.id);
      await loadAllSchedules(db);
      const next = schedulesSignal.value;
      schedulesSignal.value = next;
      if (currentScheduleSignal.value?.id === plan.id) {
        const latest = next.length > 0 ? next.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
        currentScheduleSignal.value = latest;
      }
    });
  }

  async function handleDeleteSelectedHistories(): Promise<void> {
    if (selectedHistoryIds.size === 0) return;
    const ids = [...selectedHistoryIds];
    confirmDialog(t('confirmDelete'), t('deleteSelectedHistories', String(ids.length)), async () => {
      await Promise.all(ids.map((id) => db.schedules.delete(id)));
      await loadAllSchedules(db);
      const nextCurrent = currentScheduleSignal.value;
      if (nextCurrent && !schedulesSignal.value.some((item) => item.id === nextCurrent.id)) {
        const nextLatest = schedulesSignal.value
          .filter((item) => item.configId === selectedConfigId)
          .reduce<SchedulePlan | null>((acc, item) => {
            if (!acc || item.createdAt > acc.createdAt) return item;
            return acc;
          }, null);
        currentScheduleSignal.value = nextLatest;
      }
      setSelectedHistoryIds(new Set());
    });
  }

  function toggleHistorySelection(planId: string): void {
    setSelectedHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) {
        next.delete(planId);
      } else {
        next.add(planId);
      }
      return next;
    });
  }

  async function handleSaveHistoryNotes(plan: SchedulePlan, notes: string) {
    const updated = { ...plan, notes, modifiedAt: Date.now() };
    await db.schedules.put(updated);
    await loadAllSchedules(db);
    if (currentScheduleSignal.value?.id === plan.id) {
      currentScheduleSignal.value = updated;
    }
  }

  async function handleSaveUnavail(u: PersonUnavailability) {
    await db.unavailabilities.put(u);
    await loadAllUnavailabilities(db);
    setShowUnavailForm(false);
  }

  async function handleDeleteUnavail(id: string) {
    await db.unavailabilities.delete(id);
    await loadAllUnavailabilities(db);
  }

  async function handleApplySessionMutation(): Promise<void> {
    if (!current || !sessionMutationDialog) return;
    const { mode, sessionDate } = sessionMutationDialog;
    const baseSessions = current.sessions.map((session) => ({
      date: session.date,
      presentations: session.presentations.map((presentation) => ({
        presenterId: presentation.presenterId,
        questionerIds: [...presentation.questionerIds],
      })),
    }));
    const existingMutations = current.sessionMutations ?? [];
    if (existingMutations.some((record) => record.date === sessionDate)) {
      toast.error(t('mutationAlreadyExistsForDate'));
      return;
    }

    const targetIndex = baseSessions.findIndex((item) => item.date === sessionDate);
    if (targetIndex < 0) {
      toast.error(t('mutationTargetNotFound'));
      return;
    }

    let nextSessions = baseSessions;
    let mutationNote = '';
    const createdAt = Date.now();
    const nextMutations = [...existingMutations];

    if (mode === 'delete') {
      nextSessions = baseSessions.filter((item) => item.date !== sessionDate);
      nextMutations.push({
        date: sessionDate,
        action: 'delete',
        createdAt,
      });
      mutationNote = `[temporary-delete] date=${sessionDate}`;
    } else {
      if (!insertedSessionDate) {
        toast.error(t('mutationInsertedDateRequired'));
        return;
      }
      const template = baseSessions[targetIndex];
      const insertedSession: Session = {
        date: insertedSessionDate,
        presentations: template.presentations.map((presentation) => ({
          presenterId: presentation.presenterId,
          questionerIds: [...presentation.questionerIds],
        })),
      };
      const insertIndex = insertPosition === 'before' ? targetIndex : targetIndex + 1;
      nextSessions = [...baseSessions.slice(0, insertIndex), insertedSession, ...baseSessions.slice(insertIndex)];
      nextMutations.push({
        date: sessionDate,
        action: 'insert',
        insertedDate: insertedSessionDate,
        position: insertPosition,
        createdAt,
      });
      mutationNote = `[temporary-insert-${insertPosition}] date=${sessionDate} inserted=${insertedSessionDate}`;
    }

    const mutated: SchedulePlan = {
      ...current,
      id: nanoid(),
      createdAt,
      modifiedAt: createdAt,
      sessions: nextSessions,
      sessionMutations: nextMutations,
      notes: `${current.notes ?? ''}\n${mutationNote}`.trim(),
    };

    await db.schedules.put(mutated);
    await loadAllSchedules(db);
    currentScheduleSignal.value = mutated;
    setSessionMutationDialog(null);
    setInsertedSessionDate('');
    const local = localMetricsForPlan(mutated);
    if (local) {
      openMetricsDialog(t('metricsAfterMutationTitle'), local.metrics, local.explanations);
    }
  }

  function openSessionMutationDialog(mode: 'insert' | 'delete', sessionDate: string): void {
    setSessionMutationDialog({ mode, sessionDate });
    setInsertedSessionDate(sessionDate);
    setInsertPosition('after');
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navSchedule')}</h2>
        <Button
          variant={manualEditMode ? 'primary' : 'ghost'}
          onClick={() => setManualEditMode(m => !m)}
        >
          <Pencil size={14} />
          {manualEditMode ? t('manualEditMode') : t('manualEdit')}
        </Button>
      </div>

      {/* Config section */}
      <div class={`${s.card} ${s.mb24}`}>
        <div class={`${s.flexBetween} ${s.mb12}`}>
          <strong>{t('configTitle')}</strong>
          <div class={s.flexGapSm}>
            {selectedConfig && (
              <Button variant="ghost" onClick={() => { setEditingConfig(selectedConfig); setShowConfigForm(true); }}>
                {t('editConfig')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => { setEditingConfig(null); setShowConfigForm(true); }}>
              + {t('newConfig')}
            </Button>
          </div>
        </div>

        {configs.length === 0 ? (
          <p class={`${s.text14} ${s.textMuted}`}>{t('noConfigYet')}</p>
        ) : (
          <select
            class={s.input}
            value={selectedConfigId}
            onChange={e => setSelectedConfigId((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t('selectConfigFirst')}</option>
            {configs.map(c => (
              <option key={c.id} value={c.id}>
                {getScheduleConfigLabel(c)}
              </option>
            ))}
          </select>
        )}
        {selectedConfig && (
          <div class={`${s.text12} ${s.textMuted} ${s.mt8}`}>
            {getScheduleConfigSummary(selectedConfig)}
          </div>
        )}
      </div>

      {/* Unavailability section (per config) */}
      {selectedConfigId && (
        <div class={`${s.card} ${s.mb24}`}>
          <div class={`${s.flexBetween} ${s.mb12}`}>
            <strong>{t('unavailability')}</strong>
            <Button variant="secondary" onClick={() => setShowUnavailForm(true)}>
              + {t('addUnavailability')}
            </Button>
          </div>
          {configUnavails.length === 0 ? (
            <p class={`${s.text14} ${s.textMuted}`}>—</p>
          ) : (
            <ResponsiveDataView
              items={configUnavails}
              columns={[
                { header: t('unavailPerson') },
                { header: t('unavailStart') },
                { header: t('unavailEnd') },
              ]}
              getKey={unavail => unavail.id}
              renderDesktopRow={unavail => {
                const person = personMap.get(unavail.personId);
                return (
                  <>
                    <td class={s.td}>{person ? displayName(person) : fallbackEntityId(unavail.personId)}</td>
                    <td class={s.td}>{unavail.startDate}</td>
                    <td class={s.td}>{unavail.endDate}</td>
                  </>
                );
              }}
              renderMobileCard={unavail => {
                const person = personMap.get(unavail.personId);
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div class={dataStyles.mobileTitle}>
                        {person ? displayName(person) : fallbackEntityId(unavail.personId)}
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('unavailStart')}>
                        {unavail.startDate}
                      </ResponsiveDataField>
                      <ResponsiveDataField label={t('unavailEnd')}>
                        {unavail.endDate}
                      </ResponsiveDataField>
                    </div>
                  </>
                );
              }}
              renderActions={unavail => (
                <Button variant="danger" onClick={() => handleDeleteUnavail(unavail.id)}>{t('delete')}</Button>
              )}
            />
          )}
        </div>
      )}

      {showUnavailForm && selectedConfigId && (
        <Dialog open={true} onClose={() => setShowUnavailForm(false)} closeOnOverlayClick={false} title={t('addUnavailability')}>
          <UnavailForm
            configId={selectedConfigId}
            onSave={handleSaveUnavail}
            onCancel={() => setShowUnavailForm(false)}
          />
        </Dialog>
      )}

      {showConfigForm && (
        <Dialog
          open={true}
          onClose={() => { setShowConfigForm(false); setEditingConfig(null); }}
          closeOnOverlayClick={false}
          title={editingConfig ? t('editConfig') : t('newConfig')}
        >
          <ConfigForm
            initial={editingConfig ?? undefined}
            onSave={handleSaveConfig}
            onCancel={() => { setShowConfigForm(false); setEditingConfig(null); }}
          />
        </Dialog>
      )}

      {/* Generate / Incremental row */}
      <div class={`${s.toolbar} ${s.mb8}`}>
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={isComputing || !selectedConfigId || configs.length === 0 || activePersonCount === 0}
          title={activePersonCount === 0 ? t('notEnoughPersons') : undefined}
        >
          {isComputing ? t('computing') : t('generateSchedule')}
        </Button>
        {activePersonCount === 0 && persons.length > 0 && (
          <span class={`${s.text12} ${s.textDanger}`}>{t('notEnoughPersons')}</span>
        )}
        {current && (
          <>
            <Button variant="ghost" onClick={() => setChangeDate(defaultIncrementalDate())} title={t('today')}>
              {t('defaultPlusOneWeek')}
            </Button>
            <input
              class={`${s.input} ${s.autoWidthInput}`}
              type="date"
              value={changeDate}
              onInput={e => setChangeDate((e.target as HTMLInputElement).value)}
            />
            <Button variant="secondary" onClick={handleIncremental} disabled={isComputing || !changeDate}>
              {t('incrementalReschedule')}
            </Button>
          </>
        )}
      </div>

      {/* Copy / Export row */}
      {current && (
        <div class={`${s.toolbar} ${s.mb24}`}>
          <Button variant="secondary" onClick={handleCopyTsv}>
            {copiedTsv ? `✓ ${t('copyToClipboard')}` : t('copyToClipboard')}
          </Button>
          <Button variant="secondary" onClick={handleCopyHtml}>
            {copiedHtml ? `✓ ${t('copyAsHtml')}` : t('copyAsHtml')}
          </Button>
          <Button variant="secondary" onClick={handleCopyCsv}>
            {copiedCsv ? `✓ ${t('copyAsCsv')}` : t('copyAsCsv')}
          </Button>
          <Button variant="secondary" onClick={() => downloadScheduleHtml(current, personMap, displayName)}>{t('exportHtml')}</Button>
          <Button variant="secondary" onClick={() => downloadScheduleCsv(current, personMap, displayName)}>{t('exportCsv')}</Button>
          <Button variant="secondary" onClick={handleExportIcs}>{t('exportIcs')}</Button>
        </div>
      )}

      {/* History */}
      {selectedConfigId && schedulesForSelectedConfig.length > 0 && (
        <div class={s.mb24}>
          <div class={`${s.flexBetween} ${s.mt8}`}>
            <strong class={s.text14}>{t('historyTitle')}</strong>
            <div class={s.flexGapSm}>
              <Button
                variant="danger"
                disabled={selectedHistoryIds.size === 0}
                onClick={() => void handleDeleteSelectedHistories()}
              >
                {t('deleteSelected')}
              </Button>
            </div>
          </div>
          <div class={`${s.flexGapSm} ${s.flexWrap} ${s.mt8}`}>
            {[...schedulesForSelectedConfig]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(p => (
                <Menu key={p.id} mode="context">
                  <MenuTrigger>
                    <div class={s.historyItem}>
                      <input
                        type="checkbox"
                        checked={selectedHistoryIds.has(p.id)}
                        onChange={() => toggleHistorySelection(p.id)}
                      />
                      <button
                        class={`${s.badgeButton} ${current?.id === p.id ? '' : s.badgeButtonDimmed}`}
                        onClick={() => (currentScheduleSignal.value = p)}
                      >
                        {new Date(p.createdAt).toLocaleString()}
                        {p.notes && <span class={`${s.text12} ${s.textMuted}`}> — {p.notes}</span>}
                      </button>
                      <button
                        class={s.historyDeleteButton}
                        onClick={() => void handleDeleteHistory(p)}
                        title={t('delete')}
                        aria-label={t('delete')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => {
                      const txt = `${new Date(p.createdAt).toLocaleString()}${p.notes ? ' — ' + p.notes : ''}`;
                      navigator.clipboard?.writeText(txt).then(
                        () => toast.success(t('copyToClipboard')),
                        () => toast.error(t('importError')),
                      );
                    }}>
                      {t('copySchedule')}
                    </MenuItem>
                    <MenuItem onSelect={() => setEditingNotes(p)}>
                      {t('editNotes')}
                    </MenuItem>
                    <MenuItem onSelect={() => void showMetricsForPlan(p)}>
                      {t('viewMetrics')}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => handleDeleteHistory(p)} danger>
                      {t('delete')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ))}
          </div>
        </div>
      )}

      {/* Notes edit dialog */}
      {editingNotes && (
        <HistoryNotesDialog
          plan={editingNotes}
          onSave={notes => void handleSaveHistoryNotes(editingNotes, notes)}
          onClose={() => setEditingNotes(null)}
        />
      )}

      {/* Manual edit dialog */}
      {manualEditTarget && (
        <ManualEditDialog
          {...manualEditTarget}
          onClose={() => setManualEditTarget(null)}
        />
      )}

      {metricsDialog && (
        <Dialog open={true} onClose={() => setMetricsDialog(null)} title={metricsDialog.title}>
          <div class={s.formGroup}>
            {metricsDialog.explanations.map((item) => (
              <div key={item.key} class={`${s.text14} ${s.mb8}`}>
                <strong>{item.label}</strong>: {item.value.toFixed(3)}
                <div class={s.textMuted}>{item.summary}</div>
              </div>
            ))}
          </div>
        </Dialog>
      )}

      {sessionMutationDialog && (
        <Dialog
          open={true}
          onClose={() => setSessionMutationDialog(null)}
          title={sessionMutationDialog.mode === 'insert' ? t('mutationInsertDialogTitle') : t('mutationDeleteDialogTitle')}
        >
          <div class={s.formGroup}>
            <label class={s.label}>{t('sessionDate')}</label>
            <input class={s.input} value={sessionMutationDialog.sessionDate} disabled />
          </div>
          {sessionMutationDialog.mode === 'insert' && (
            <>
              <div class={s.formGroup}>
                <label class={s.label}>{t('mutationInsertedDate')}</label>
                <input
                  class={s.input}
                  type="date"
                  value={insertedSessionDate}
                  onInput={(e) => setInsertedSessionDate((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class={s.formGroup}>
                <label class={s.label}>{t('mutationInsertPosition')}</label>
                <select
                  class={s.input}
                  value={insertPosition}
                  onChange={(e) => setInsertPosition((e.target as HTMLSelectElement).value as 'before' | 'after')}
                >
                  <option value="before">{t('mutationBefore')}</option>
                  <option value="after">{t('mutationAfter')}</option>
                </select>
              </div>
            </>
          )}
          <div class={s.flexGapSm}>
            <Button variant="primary" onClick={() => void handleApplySessionMutation()}>{t('applyMutation')}</Button>
            <Button variant="secondary" onClick={() => setSessionMutationDialog(null)}>{t('cancel')}</Button>
          </div>
        </Dialog>
      )}

      {/* Schedule tables */}
      {!selectedConfigId || !current || current.configId !== selectedConfigId ? (
        <div class={s.cardNoScheduke}>{t('noSchedule')}</div>
      ) : (
        current.sessions.map(sess => {
          const hasMutationRecord = (current.sessionMutations ?? []).some((record) => record.date === sess.date);
          return (
          <div key={sess.date} class={`${s.card} ${s.mb16}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>
              <span class={s.flexGapXs}>
                <Calendar size={16} />
                {sess.date}
              </span>
              <div class={s.flexGapXs}>
                {manualEditMode && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => openSessionMutationDialog('insert', sess.date)}
                      disabled={hasMutationRecord}
                    >
                      {t('mutationInsert')}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => openSessionMutationDialog('delete', sess.date)}
                      disabled={hasMutationRecord}
                    >
                      {t('mutationDelete')}
                    </Button>
                  </>
                )}
                <Button variant="ghost" onClick={() => void showMetricsForSession(current, sess.date)}>
                  {t('viewMetrics')}
                </Button>
              </div>
            </h3>
            <ResponsiveDataView
              items={sess.presentations}
              columns={[
                { header: t('presenter') },
                { header: t('questioners') },
              ]}
              getKey={(_, index) => index}
              colGroup={
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '70%' }} />
                </colgroup>
              }
              renderDesktopRow={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <td class={s.td}>
                      {manualEditMode ? (
                        <Menu mode="context">
                          <MenuTrigger>
                            <span class={s.editableCell}>
                              {presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}
                            </span>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setManualEditTarget({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}>
                              {t('selectNewPresenter')}
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : (
                        presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)
                      )}
                    </td>
                    <td class={s.td}>
                      <div class={s.tagList}>
                        {pres.questionerIds.map((qid, qi) => {
                          const questioner = personMap.get(qid);
                          const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                          return manualEditMode ? (
                            <Menu key={`${qid}-${qi}`} mode="context">
                              <MenuTrigger>
                                <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem onSelect={() => setManualEditTarget({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                  {t('selectNewQuestioner')}
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          ) : (
                            <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                          );
                        })}
                      </div>
                    </td>
                  </>
                );
              }}
              renderMobileCard={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div>
                        <div class={dataStyles.mobileTitle}>{presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}</div>
                        <div class={dataStyles.mobileSubtitle}>{t('presenter')}</div>
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('questioners')}>
                        <div class={s.tagList}>
                          {pres.questionerIds.map((qid, qi) => {
                            const questioner = personMap.get(qid);
                            const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                            return manualEditMode ? (
                              <Menu key={`${qid}-${qi}`} mode="context">
                                <MenuTrigger>
                                  <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                                </MenuTrigger>
                                <MenuContent>
                                  <MenuItem onSelect={() => setManualEditTarget({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                    {t('selectNewQuestioner')}
                                  </MenuItem>
                                </MenuContent>
                              </Menu>
                            ) : (
                              <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                            );
                          })}
                        </div>
                      </ResponsiveDataField>
                    </div>
                    {manualEditMode && (
                      <div class={s.flexGapXs}>
                        <Button
                          variant="ghost"
                          onClick={() => setManualEditTarget({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}
                        >
                          {t('selectNewPresenter')}
                        </Button>
                      </div>
                    )}
                  </>
                );
              }}
            />
          </div>
          );
        })
      )}
    </div>
  );
}
