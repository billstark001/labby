import { useEffect, useMemo, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { Pencil } from 'lucide-preact';
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
} from '@/store/index';
import { displayName } from '@/i18n';
import {
  loadAllConfigs,
  loadAllConstraints,
  loadAllEmailTasks,
  loadAllPersons,
  loadAllSchedules,
  loadAllSimilarities,
  loadAllUnavailabilities,
  useDatabase,
} from '@/db/index';
import { computeScheduleMetrics, explainScheduleMetrics, mutatePresentations, mutateSessions, solveFull, solveIncremental } from '@labby/core';
import type { ScheduleConfig, SchedulePlan, PersonUnavailability, MetricExplanation, ScheduleMetrics } from '@labby/core';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
import {
  copyScheduleTable,
  copyScheduleHtml,
  copyScheduleCsv,
  downloadScheduleCsv,
  downloadScheduleHtml,
  downloadScheduleIcs,
} from '@/lib/scheduleExport';
import { confirmDialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { apiClient } from '@/lib/api';
import { isServerDeployment } from '@/lib/runtime';
import { i18n } from '@/i18n';
import { ConfigPanel } from './ConfigPanel';
import { ScheduleHistoryPanel } from './ScheduleHistoryPanel';
import { ScheduleView } from './ScheduleView';
import {
  ManualEditDialog,
  MetricsDialog,
  PresentationMutationDialog,
  SessionMutationDialog,
  type MetricsDialogState,
  type PresentationMutationDialogState,
  type SessionMutationDialogState,
} from './dialogs';

const LAST_SELECTED_CONFIG_STORAGE_KEY = 'schedule.lastSelectedConfigId';

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
    return result as { plan: SchedulePlan; metrics?: ScheduleMetrics; explanations?: MetricExplanation[]; warnings?: string[] };
  }
  return { plan: result as SchedulePlan };
}

function buildSessionDateMeta(
  sessions: SchedulePlan['sessions'],
  mutations: SchedulePlan['sessionMutations'],
  existing: SchedulePlan['sessionDateMeta'],
): NonNullable<SchedulePlan['sessionDateMeta']> {
  const existingMap = existing ?? {};
  const insertMap = new Map<string, { action: 'insert' | 'delete'; createdAt: number }>();
  for (const m of mutations ?? []) {
    if (m.action === 'insert') {
      insertMap.set(m.date, { action: m.action, createdAt: m.createdAt });
    }
  }

  const out: NonNullable<SchedulePlan['sessionDateMeta']> = {};
  for (const session of sessions) {
    const meta = existingMap[session.date] ?? insertMap.get(session.date);
    if (meta) {
      out[session.date] = meta;
    }
  }
  return out;
}

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
  const [sessionMutationTactic, setSessionMutationTactic] = useState<'shift' | 'keep'>('keep');
  const [sessionMutationCount, setSessionMutationCount] = useState(1);
  const [presentationMutationDialog, setPresentationMutationDialog] = useState<PresentationMutationDialogState | null>(null);
  const [presentationMutationOperation, setPresentationMutationOperation] = useState<'insert' | 'delete'>('insert');
  const [presentationMutationCount, setPresentationMutationCount] = useState(1);
  const [presentationMutationTactic, setPresentationMutationTactic] = useState<'shift' | 'keep'>('keep');
  const [presentationMutationChangeSessionLength, setPresentationMutationChangeSessionLength] = useState(true);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());

  const activePersonCount = persons.filter(p => !p.disabled).length;
  const selectedConfig = configs.find(c => c.id === selectedConfigId);
  const schedulesForSelectedConfig = useMemo(
    () => (selectedConfigId ? schedules.filter(item => item.configId === selectedConfigId) : []),
    [schedules, selectedConfigId],
  );
  const sortedHistoryPlans = useMemo(
    () => [...schedulesForSelectedConfig].sort((a, b) => b.createdAt - a.createdAt),
    [schedulesForSelectedConfig],
  );
  const personMap = personMapSignal.value;
  const configUnavails = unavailabilities.filter(u => u.configId === selectedConfigId);


  // #region Effects

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
      if (remembered && configsSignal.value.some(item => item.id === remembered)) {
        setSelectedConfigId(remembered);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [db]);

  useEffect(() => {
    if (selectedConfigId && !configs.some(item => item.id === selectedConfigId)) {
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
    setSelectedHistoryIds(new Set());
  }, [selectedConfigId]);

  useEffect(() => {
    if (!selectedConfigId) return;
    const currentPlan = currentScheduleSignal.value;
    if (!currentPlan || currentPlan.configId !== selectedConfigId) {
      const latest = schedulesForSelectedConfig.reduce<SchedulePlan | null>(
        (acc, item) => (!acc || item.createdAt > acc.createdAt ? item : acc),
        null,
      );
      currentScheduleSignal.value = latest;
    }
  }, [selectedConfigId, schedulesForSelectedConfig]);

  useEffect(() => {
    if (!changeDate) setChangeDate(defaultIncrementalDate());
  }, [changeDate]);

  // #endregion

  // #region Helpers

  function localMetricsForPlan(plan: SchedulePlan) {
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

  function openMetricsDialog(title: string, metrics: ScheduleMetrics, explanations: MetricExplanation[]) {
    setMetricsDialog({ title, metrics, explanations });
  }

  function maybeShowLocalMetrics(plan: SchedulePlan, title: string) {
    const local = localMetricsForPlan(plan);
    if (local) openMetricsDialog(title, local.metrics, local.explanations);
  }

  async function handleSolveResult(result: unknown) {
    const normalized = normalizeSolveResponse(result);
    const planWithMeta: SchedulePlan = {
      ...normalized.plan,
      sessionDateMeta: buildSessionDateMeta(
        normalized.plan.sessions,
        normalized.plan.sessionMutations,
        normalized.plan.sessionDateMeta,
      ),
    };
    await db.schedules.put({ ...planWithMeta, modifiedAt: Date.now() });
    await loadAllSchedules(db);
    currentScheduleSignal.value = { ...planWithMeta, modifiedAt: Date.now() };
    if (normalized.metrics && normalized.explanations) {
      openMetricsDialog(t('metricsAfterComputeTitle'), normalized.metrics, normalized.explanations);
    } else {
      maybeShowLocalMetrics(planWithMeta, t('metricsAfterComputeTitle'));
    }
    if (normalized.warnings?.length) window.alert(normalized.warnings.join('\n'));
  }

  // #endregion

  // #region Metrics

  async function showMetricsForPlan(plan: SchedulePlan): Promise<void> {
    if (isServerDeployment) {
      const data = await apiClient.request<{ metrics: ScheduleMetrics; explanations: MetricExplanation[] }>('/solver/metrics', {
        method: 'POST',
        body: JSON.stringify({ scheduleId: plan.id }),
      });
      openMetricsDialog(`${t('historyTitle')} · ${new Date(plan.createdAt).toLocaleString()}`, data.metrics, data.explanations);
      return;
    }
    maybeShowLocalMetrics(plan, `${t('historyTitle')} · ${new Date(plan.createdAt).toLocaleString()}`);
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
    const sessionIndex = plan.sessions.findIndex(session => session.date === sessionDate);
    if (sessionIndex < 0) return;
    const metrics = computeScheduleMetrics(
      { ...plan, sessions: [plan.sessions[sessionIndex]] },
      { persons, similarities: similarityMapSignal.value, config, unavailabilities, constraints },
      plan.sessions.slice(0, sessionIndex),
    );
    openMetricsDialog(`${sessionDate} · ${t('sessionDate')}`, metrics, explainScheduleMetrics(metrics));
  }

  // #endregion

  // #region Config

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put({ ...c, modifiedAt: Date.now() });
    await loadAllConfigs(db);
    setShowConfigForm(false);
    setEditingConfig(null);
    if (!selectedConfigId) setSelectedConfigId(c.id);
  }

  // #endregion

  // #region Solve

  async function handleGenerate() {
    const config = configs.find(c => c.id === selectedConfigId);
    if (!config || activePersonCount === 0) return;
    if (config.startDate < defaultIncrementalDate() && !window.confirm(t('rescheduleDateEarlyWarning'))) return;
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const result = isServerDeployment
        ? await apiClient.request<unknown>('/solver/run', {
          method: 'POST',
          body: JSON.stringify({ configId: config.id, personIds: persons.map(p => p.id) }),
        })
        : {
          plan: {
            id: nanoid(),
            createdAt: Date.now(),
            configId: config.id,
            sessions: solveFull({
              persons,
              similarities: similarityMapSignal.value,
              config,
              unavailabilities,
              constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === config.id),
            }),
          } satisfies SchedulePlan,
        };
      await handleSolveResult(result);
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
    if (changeDate < defaultIncrementalDate() && !window.confirm(t('rescheduleDateEarlyWarning'))) return;
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const result = isServerDeployment
        ? await apiClient.request<unknown>('/solver/run-incremental', {
          method: 'POST',
          body: JSON.stringify({ configId: config.id, previousPlanId: current.id, changeDate, personIds: persons.map(p => p.id) }),
        })
        : {
          plan: {
            id: nanoid(),
            createdAt: Date.now(),
            configId: config.id,
            sessions: solveIncremental({
              persons,
              similarities: similarityMapSignal.value,
              config,
              sessions: current.sessions,
              mutations: current.sessionMutations,
              changeDate,
              unavailabilities,
              constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === config.id),
            }),
            sessionMutations: current.sessionMutations,
          } satisfies SchedulePlan,
        };
      await handleSolveResult(result);
      toast.dismiss(tid);
      toast.success(t('computeSuccess'));
    } catch (err) {
      toast.dismiss(tid);
      toast.error(`${t('computeError')}: ${String(err)}`);
    } finally {
      isComputingSignal.value = false;
    }
  }

  // #endregion

  // #region Copy / Export

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

  // #endregion

  // #region History

  async function handleDeleteHistory(plan: SchedulePlan) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.schedules.delete(plan.id);
      await loadAllSchedules(db);
      const next = schedulesSignal.value;
      if (currentScheduleSignal.value?.id === plan.id) {
        currentScheduleSignal.value = next.length > 0 ? next.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
      }
    });
  }

  async function handleDeleteSelectedHistories(): Promise<void> {
    if (selectedHistoryIds.size === 0) return;
    const ids = [...selectedHistoryIds];
    confirmDialog(t('confirmDelete'), t('deleteSelectedHistories', String(ids.length)), async () => {
      await Promise.all(ids.map(id => db.schedules.delete(id)));
      await loadAllSchedules(db);
      const nextCurrent = currentScheduleSignal.value;
      if (nextCurrent && !schedulesSignal.value.some(item => item.id === nextCurrent.id)) {
        currentScheduleSignal.value = schedulesSignal.value
          .filter(item => item.configId === selectedConfigId)
          .reduce<SchedulePlan | null>((acc, item) => (!acc || item.createdAt > acc.createdAt ? item : acc), null);
      }
      setSelectedHistoryIds(new Set());
    });
  }

  function toggleHistorySelection(planId: string) {
    setSelectedHistoryIds(prev => {
      const next = new Set(prev);
      next.has(planId) ? next.delete(planId) : next.add(planId);
      return next;
    });
  }

  async function handleSaveHistoryNotes(plan: SchedulePlan, notes: string) {
    const updated = { ...plan, notes, modifiedAt: Date.now() };
    await db.schedules.put(updated);
    await loadAllSchedules(db);
    if (currentScheduleSignal.value?.id === plan.id) currentScheduleSignal.value = updated;
  }

  // #endregion

  // #region Unavailabilities

  async function handleSaveUnavail(u: PersonUnavailability) {
    await db.unavailabilities.put(u);
    await loadAllUnavailabilities(db);
    setShowUnavailForm(false);
  }

  async function handleDeleteUnavail(id: string) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      try {
        await db.unavailabilities.delete(id);
        await loadAllUnavailabilities(db);
      } catch (err) {
        toast.error(`${t('computeError')}: ${String(err)}`);
      }
    });
  }

  // #endregion

  // #region Session mutations

  function openSessionMutationDialog(mode: 'insert' | 'delete', sessionDate: string) {
    setSessionMutationDialog({ mode, sessionDate });
    setInsertedSessionDate(sessionDate);
    setInsertPosition('after');
    setSessionMutationTactic('keep');
    setSessionMutationCount(1);
  }

  function openPresentationMutationDialog(sessionDate: string, presentationIndex: number) {
    setPresentationMutationDialog({ sessionDate, presentationIndex });
    setPresentationMutationOperation('insert');
    setPresentationMutationCount(1);
    setPresentationMutationTactic('keep');
    setPresentationMutationChangeSessionLength(true);
  }

  async function handleApplySessionMutation(): Promise<void> {
    if (!current || !sessionMutationDialog) return;
    if (!selectedConfig) {
      toast.error(t('computeError'));
      return;
    }
    const { mode, sessionDate } = sessionMutationDialog;
    const targetIndex = current.sessions.findIndex(item => item.date === sessionDate);
    if (targetIndex < 0) { toast.error(t('mutationTargetNotFound')); return; }

    const existingMutations = current.sessionMutations ?? [];
    const count = Math.max(1, Math.floor(sessionMutationCount));
    let mutationDate = sessionDate;
    if (mode === 'insert') {
      if (!insertedSessionDate) { toast.error(t('mutationInsertedDateRequired')); return; }
      mutationDate = insertedSessionDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(mutationDate)) {
        toast.error(t('mutationInsertedDateRequired'));
        return;
      }
      if (mutationDate < selectedConfig.startDate || mutationDate > selectedConfig.endDate) {
        toast.error(`date must be within ${selectedConfig.startDate} ~ ${selectedConfig.endDate}`);
        return;
      }
    }

    if (mode === 'delete') {
      if (sessionMutationTactic === 'keep' && targetIndex + count > current.sessions.length) {
        toast.error('delete range exceeds available sessions');
        return;
      }
      if (sessionMutationTactic === 'shift' && count > current.sessions.length) {
        toast.error('delete count exceeds available sessions');
        return;
      }
    }

    const next = mode === 'delete'
      ? mutateSessions(
        current.sessions,
        {
          config: selectedConfig,
          persons,
          mutations: existingMutations,
          unavailabilities,
          constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === selectedConfig.id),
        },
        { operation: 'delete', index: targetIndex, count, tactic: sessionMutationTactic },
      )
      : mutateSessions(
        current.sessions,
        {
          config: selectedConfig,
          persons,
          mutations: existingMutations,
          unavailabilities,
          constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === selectedConfig.id),
        },
        {
          operation: 'insert',
          index: sessionMutationTactic === 'shift'
            ? 0
            : (insertPosition === 'before' ? targetIndex : targetIndex + 1),
          dates: [mutationDate],
          tactic: sessionMutationTactic,
        },
      );

    const createdAt = Date.now();
    const mutationNote = mode === 'delete'
      ? `[temporary-delete] date=${sessionDate}`
      : `[temporary-insert-${insertPosition}] date=${sessionDate} inserted=${mutationDate}`;

    const mutated: SchedulePlan = {
      ...current,
      id: nanoid(),
      createdAt,
      modifiedAt: createdAt,
      sessions: next.sessions,
      sessionMutations: next.mutations,
      sessionDateMeta: buildSessionDateMeta(next.sessions, next.mutations, current.sessionDateMeta),
      notes: `${current.notes ?? ''}\n${mutationNote}`.trim(),
    };

    await db.schedules.put(mutated);
    await loadAllSchedules(db);
    currentScheduleSignal.value = mutated;
    setSessionMutationDialog(null);
    setInsertedSessionDate('');
    maybeShowLocalMetrics(mutated, t('metricsAfterMutationTitle'));
  }

  async function handleApplyPresentationMutation(): Promise<void> {
    if (!current || !presentationMutationDialog || !selectedConfig) return;
    const { sessionDate, presentationIndex } = presentationMutationDialog;
    const sessionIndex = current.sessions.findIndex(item => item.date === sessionDate);
    if (sessionIndex < 0) {
      toast.error(t('mutationTargetNotFound'));
      return;
    }

    const count = Math.max(1, Math.floor(presentationMutationCount));
    const currentLen = current.sessions[sessionIndex]?.presentations.length ?? 0;
    if (presentationMutationOperation === 'delete') {
      if (presentationMutationTactic === 'keep' && presentationIndex + count > currentLen) {
        toast.error('delete range exceeds available presentations');
        return;
      }
      if (presentationMutationTactic === 'shift' && count > currentLen) {
        toast.error('delete count exceeds available presentations');
        return;
      }
    }

    let nextSessions: SchedulePlan['sessions'];
    try {
      nextSessions = mutatePresentations(
        current.sessions,
        {
          config: selectedConfig,
          persons,
          mutations: current.sessionMutations,
          unavailabilities,
          constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === selectedConfig.id),
        },
        {
          sessionIndex,
          index: presentationIndex,
          operation: presentationMutationOperation,
          count,
          tactic: presentationMutationTactic,
          changeSessionLength: presentationMutationChangeSessionLength,
        },
      );
    } catch (err) {
      toast.error(String(err));
      return;
    }

    const createdAt = Date.now();
    const mutated: SchedulePlan = {
      ...current,
      id: nanoid(),
      createdAt,
      modifiedAt: createdAt,
      sessions: nextSessions,
      notes: `${current.notes ?? ''}\n[presentation-mutation] session=${sessionDate} index=${presentationIndex + 1}`.trim(),
    };

    await db.schedules.put(mutated);
    await loadAllSchedules(db);
    currentScheduleSignal.value = mutated;
    setPresentationMutationDialog(null);
    maybeShowLocalMetrics(mutated, t('metricsAfterMutationTitle'));
  }

  // #endregion

  // #region Render

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navSchedule')}</h2>
        <Button variant={manualEditMode ? 'primary' : 'ghost'} onClick={() => setManualEditMode(m => !m)}>
          <Pencil size={14} />
          {manualEditMode ? t('manualEditMode') : t('manualEdit')}
        </Button>
      </div>

      <ConfigPanel
        configs={configs}
        selectedConfigId={selectedConfigId}
        selectedConfig={selectedConfig}
        configUnavails={configUnavails}
        personMap={personMap}
        onSelectConfig={setSelectedConfigId}
        onNewConfig={() => { setEditingConfig(null); setShowConfigForm(true); }}
        onEditConfig={config => { setEditingConfig(config); setShowConfigForm(true); }}
        onDeleteConfig={config => {
          confirmDialog(t('confirmDelete'), t('deleteConfigWarning'), async () => {
            await db.configs.delete(config.id);
            await loadAllConfigs(db);
            setSelectedConfigId('');
          });
        }}
        onAddUnavail={() => setShowUnavailForm(true)}
        onDeleteUnavail={handleDeleteUnavail}
        showUnavailForm={showUnavailForm}
        onCloseUnavailForm={() => setShowUnavailForm(false)}
        onSaveUnavail={handleSaveUnavail}
        showConfigForm={showConfigForm}
        onCloseConfigForm={() => { setShowConfigForm(false); setEditingConfig(null); }}
        onSaveConfig={handleSaveConfig}
        editingConfig={editingConfig}
      />

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
          <Button variant="secondary" onClick={handleCopyTsv}>{copiedTsv ? `✓ ${t('copyToClipboard')}` : t('copyToClipboard')}</Button>
          <Button variant="secondary" onClick={handleCopyHtml}>{copiedHtml ? `✓ ${t('copyAsHtml')}` : t('copyAsHtml')}</Button>
          <Button variant="secondary" onClick={handleCopyCsv}>{copiedCsv ? `✓ ${t('copyAsCsv')}` : t('copyAsCsv')}</Button>
          <Button variant="secondary" onClick={() => downloadScheduleHtml(current, personMap, displayName)}>{t('exportHtml')}</Button>
          <Button variant="secondary" onClick={() => downloadScheduleCsv(current, personMap, displayName)}>{t('exportCsv')}</Button>
          <Button variant="secondary" onClick={handleExportIcs}>{t('exportIcs')}</Button>
        </div>
      )}

      {/* History */}
      {selectedConfigId && schedulesForSelectedConfig.length > 0 && (
        <ScheduleHistoryPanel
          sortedHistoryPlans={sortedHistoryPlans}
          selectedHistoryIds={selectedHistoryIds}
          currentSchedule={current}
          onSelectHistory={plan => { currentScheduleSignal.value = plan; }}
          onToggleHistory={toggleHistorySelection}
          onSelectAll={() => setSelectedHistoryIds(new Set(sortedHistoryPlans.map(p => p.id)))}
          onClearSelection={() => setSelectedHistoryIds(new Set())}
          onInvertSelection={() => setSelectedHistoryIds(prev => new Set(sortedHistoryPlans.filter(p => !prev.has(p.id)).map(p => p.id)))}
          onDeleteHistory={handleDeleteHistory}
          onDeleteSelected={() => void handleDeleteSelectedHistories()}
          onEditNotes={setEditingNotes}
          onShowMetrics={plan => void showMetricsForPlan(plan)}
          editingNotes={editingNotes}
          onSaveNotes={(plan, notes) => void handleSaveHistoryNotes(plan, notes)}
          onCloseNotes={() => setEditingNotes(null)}
        />
      )}

      {/* Dialogs */}
      {manualEditTarget && (
        <ManualEditDialog {...manualEditTarget} onClose={() => setManualEditTarget(null)} />
      )}
      <MetricsDialog state={metricsDialog} onClose={() => setMetricsDialog(null)} />
      <SessionMutationDialog
        state={sessionMutationDialog}
        insertedSessionDate={insertedSessionDate}
        insertPosition={insertPosition}
        tactic={sessionMutationTactic}
        count={sessionMutationCount}
        minDate={selectedConfig?.startDate}
        maxDate={selectedConfig?.endDate}
        onInsertedDateChange={setInsertedSessionDate}
        onInsertPositionChange={setInsertPosition}
        onTacticChange={setSessionMutationTactic}
        onCountChange={setSessionMutationCount}
        onApply={() => void handleApplySessionMutation()}
        onClose={() => setSessionMutationDialog(null)}
      />
      <PresentationMutationDialog
        state={presentationMutationDialog}
        operation={presentationMutationOperation}
        count={presentationMutationCount}
        tactic={presentationMutationTactic}
        changeSessionLength={presentationMutationChangeSessionLength}
        onOperationChange={setPresentationMutationOperation}
        onCountChange={setPresentationMutationCount}
        onTacticChange={setPresentationMutationTactic}
        onChangeSessionLengthChange={setPresentationMutationChangeSessionLength}
        onApply={() => void handleApplyPresentationMutation()}
        onClose={() => setPresentationMutationDialog(null)}
      />

      {/* Schedule tables */}
      <ScheduleView
        current={current}
        selectedConfigId={selectedConfigId}
        personMap={personMap}
        manualEditMode={manualEditMode}
        onManualEdit={setManualEditTarget}
        onShowMetricsForSession={(plan, date) => void showMetricsForSession(plan, date)}
        onOpenSessionMutation={openSessionMutationDialog}
        onOpenPresentationMutation={openPresentationMutationDialog}
      />
    </div>
  );

  // #endregion
}