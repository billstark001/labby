import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { batch, useSignal } from '@preact/signals';
import { Pencil, Redo2, Undo2 } from 'lucide-preact';
import {
  personsSignal,
  keywordsSignal,
  keywordVectorsSignal,
  configsSignal,
  constraintsSignal,
  schedulesSignal,
  currentScheduleSignal,
  similarityLookupSignal,
  isComputingSignal,
  personMapSignal,
  personTagsSignal,
  unavailabilitiesSignal,
} from '@/store/index';
import { displayName } from '@/i18n';
import {
  readAllPaginated,
  readScheduleForeignKeys,
  useDatabase,
} from '@/db/index';
import { computeScheduleMetrics, explainScheduleMetrics, solveConstrained } from '@labby/core';
import type {
  IncrementalSolveMode,
  MetricExplanation,
  PersonUnavailability,
  ScheduleConfig,
  ScheduleMetrics,
  SchedulePlan,
} from '@labby/core';
import * as s from '@/styles/components.css';
import { Button, ContentSkeleton } from '@/components/ui/index';
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
import { i18n } from '@/i18n';
import { ConfigPanel } from './ConfigPanel';
import { ScheduleHistoryPanel } from './ScheduleHistoryPanel';
import { ScheduleView } from './ScheduleView';
import {
  addQuestioner,
  createScheduleDraft,
  deletePresentation,
  deleteQuestioner,
  deleteSession,
  discardedPresentationCount,
  insertPresentation,
  insertSession,
  moveBoundary,
  movePresentationTo,
  moveQuestioner,
  reorderPresentations,
  replacePresenter,
  replaceQuestioner,
  shiftSessionSuffix,
  type ScheduleDraft,
} from './schedule-editor';
import {
  InsertSessionDialog,
  MetricsDialog,
  type MetricsDialogState,
} from './dialogs';
import {
  createSolverBackend,
  defaultIncrementalDate,
  normalizeSolveResponse,
  buildSessionDateMeta,
  type SolverContext,
} from './service';

const LAST_SELECTED_CONFIG_STORAGE_KEY = 'schedule.lastSelectedConfigId';

// Single backend instance — isServerDeployment is a startup-time constant.
const backend = createSolverBackend();

export function SchedulePage() {
  const { t } = i18n;
  const configs = configsSignal.value;
  const persons = personsSignal.value;
  const schedules = schedulesSignal.value;
  const current = currentScheduleSignal.value;
  const isComputing = isComputingSignal.value;
  const unavailabilities = unavailabilitiesSignal.value;
  const db = useDatabase();

  // States passed to child components remain as useState.
  const [showConfigForm, setShowConfigForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ScheduleConfig | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const selectedConfigIdRef = useRef(selectedConfigId);
  selectedConfigIdRef.current = selectedConfigId;
  const [changeDate, setChangeDate] = useState('');
  const [incrementalMode, setIncrementalMode] = useState<IncrementalSolveMode>('full');
  const [showUnavailForm, setShowUnavailForm] = useState(false);
  const [editingUnavail, setEditingUnavail] = useState<PersonUnavailability | null>(null);
  const [editingNotes, setEditingNotes] = useState<SchedulePlan | null>(null);
  const [manualEditMode, setManualEditMode] = useState(false);
  const [draftSchedule, setDraftSchedule] = useState<ScheduleDraft | null>(null);
  const [undoStack, setUndoStack] = useState<ScheduleDraft[]>([]);
  const [redoStack, setRedoStack] = useState<ScheduleDraft[]>([]);
  const [metricsDialog, setMetricsDialog] = useState<MetricsDialogState | null>(null);
  const [insertSessionIndex, setInsertSessionIndex] = useState<number | null>(null);
  const [insertedSessionDate, setInsertedSessionDate] = useState('');
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const [highlightPersonId, setHighlightPersonId] = useState('');
  const [highlightTagId, setHighlightTagId] = useState('');
  const [baseStatus, setBaseStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [baseError, setBaseError] = useState<unknown>();
  const [baseRevision, setBaseRevision] = useState(0);
  const [scopedState, setScopedState] = useState<{
    key: string;
    status: 'idle' | 'pending' | 'success' | 'error';
    error?: unknown;
  }>({ key: '', status: 'idle' });
  const scopedStatus = scopedState.key === selectedConfigId ? scopedState.status : 'idle';
  const [scopeRevision, setScopeRevision] = useState(0);

  // Transient clipboard-feedback flags are component-local; signals avoid
  // a full re-render and have no child consumers, so useState is not needed.
  const copiedTsv = useSignal(false);
  const copiedHtml = useSignal(false);
  const copiedCsv = useSignal(false);

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
  const readOnlyDraft = useMemo(() => current ? createScheduleDraft(current) : null, [current]);
  const visibleDraft = manualEditMode ? draftSchedule : readOnlyDraft;
  const highlightedPersonIds = useMemo(() => new Set([
    ...(highlightPersonId ? [highlightPersonId] : []),
    ...persons.filter(person => highlightTagId && person.tagIds?.includes(highlightTagId)).map(person => person.id),
  ]), [highlightPersonId, highlightTagId, persons]);

  // #region Effects

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBaseStatus('pending');
      setBaseError(undefined);
      const [loadedPersons, loadedTags, loadedKeywords, loadedVectors, loadedConfigs] = await Promise.all([
        readAllPaginated(db.persons),
        readAllPaginated(db.personTags),
        readAllPaginated(db.keywords),
        readAllPaginated(db.keywordVectors),
        readAllPaginated(db.configs),
      ]);
      if (cancelled) return;
      batch(() => {
        personsSignal.value = loadedPersons;
        personTagsSignal.value = loadedTags;
        keywordsSignal.value = loadedKeywords;
        keywordVectorsSignal.value = loadedVectors;
        configsSignal.value = loadedConfigs;
      });
      const remembered = localStorage.getItem(LAST_SELECTED_CONFIG_STORAGE_KEY) ?? '';
      if (remembered && loadedConfigs.some(item => item.id === remembered)) {
        setSelectedConfigId(remembered);
      }
      setBaseStatus('success');
    };
    void run().catch(error => {
      if (!cancelled) {
        setBaseError(error);
        setBaseStatus('error');
      }
    });
    return () => { cancelled = true; };
  }, [db, baseRevision]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedConfigId) {
      constraintsSignal.value = [];
      schedulesSignal.value = [];
      unavailabilitiesSignal.value = [];
      setScopedState({ key: '', status: 'success' });
      return;
    }
    setScopedState({ key: selectedConfigId, status: 'pending' });
    void (async () => {
      const foreignKeys = await readScheduleForeignKeys(db, [selectedConfigId]);
      if (cancelled || selectedConfigIdRef.current !== selectedConfigId) return;
      const latest = foreignKeys.schedules.reduce<SchedulePlan | null>(
        (acc, item) => !acc || item.createdAt > acc.createdAt ? item : acc, null,
      );
      batch(() => {
        constraintsSignal.value = foreignKeys.constraints;
        schedulesSignal.value = foreignKeys.schedules;
        unavailabilitiesSignal.value = foreignKeys.unavailabilities;
        currentScheduleSignal.value = latest;
      });
      setScopedState({ key: selectedConfigId, status: 'success' });
    })().catch(error => { if (!cancelled) setScopedState({ key: selectedConfigId, status: 'error', error }); });
    return () => { cancelled = true; };
  }, [db, selectedConfigId, scopeRevision]);

  useEffect(() => {
    if (baseStatus === 'success' && selectedConfigId && !configs.some(item => item.id === selectedConfigId)) {
      setSelectedConfigId('');
      localStorage.removeItem(LAST_SELECTED_CONFIG_STORAGE_KEY);
    }
  }, [baseStatus, configs, selectedConfigId]);

  useEffect(() => {
    if (!selectedConfigId) {
      currentScheduleSignal.value = null;
      setSelectedHistoryIds(new Set());
      cancelManualEdit();
      return;
    }
    localStorage.setItem(LAST_SELECTED_CONFIG_STORAGE_KEY, selectedConfigId);
    setSelectedHistoryIds(new Set());
    cancelManualEdit();
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

  /** Builds the SolverContext from component-local reactive values. */
  function solverCtx(configId: string): SolverContext {
    return {
      persons,
      similarities: similarityLookupSignal.value,
      unavailabilities,
      constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === configId),
    };
  }

  function updateDraft(mutator: (draft: ScheduleDraft) => ScheduleDraft): void {
    setDraftSchedule((previous) => {
      if (!previous) return previous;
      const next = mutator(previous);
      if (next === previous) return previous;
      setUndoStack(stack => [...stack, previous]);
      setRedoStack([]);
      return next;
    });
  }

  function beginManualEdit(): void {
    if (!current) return;
    setDraftSchedule(createScheduleDraft(current));
    setUndoStack([]);
    setRedoStack([]);
    setManualEditMode(true);
  }

  function cancelManualEdit(): void {
    setInsertSessionIndex(null);
    setDraftSchedule(null);
    setUndoStack([]);
    setRedoStack([]);
    setManualEditMode(false);
  }

  function undoDraft(): void {
    const previous = undoStack.at(-1);
    if (!previous || !draftSchedule) return;
    setUndoStack(stack => stack.slice(0, -1));
    setRedoStack(stack => [...stack, draftSchedule]);
    setDraftSchedule(previous);
  }

  function redoDraft(): void {
    const next = redoStack.at(-1);
    if (!next || !draftSchedule) return;
    setRedoStack(stack => stack.slice(0, -1));
    setUndoStack(stack => [...stack, draftSchedule]);
    setDraftSchedule(next);
  }

  function isQuestionerPlacementValid(draft: ScheduleDraft, presentationId: string, personId: string): boolean {
    for (const session of draft.sessions) {
      const presentation = session.presentations.find(item => item.id === presentationId);
      if (!presentation) continue;
      if (presentation.presenter.kind === 'fixed' && presentation.presenter.personId === personId) return false;
      const unavailable = unavailabilities.some(item => {
        if (item.configId !== draft.configId || session.date < item.startDate || session.date > item.endDate) return false;
        const ids = item.personIds?.length ? item.personIds : item.personId ? [item.personId] : [];
        return ids.includes(personId);
      });
      if (unavailable) return false;
      if (presentation.presenter.kind === 'fixed') {
        const presenterId = presentation.presenter.personId;
        return !constraintsSignal.value.some(constraint =>
          constraint.type === 'no-overlap'
          && (!constraint.configId || constraint.configId === draft.configId)
          && constraint.personIds.includes(personId)
          && constraint.personIds.includes(presenterId),
        );
      }
      return true;
    }
    return false;
  }

  function solveDraft(draft: ScheduleDraft, config: ScheduleConfig) {
    return solveConstrained({
      config,
      persons,
      similarities: similarityLookupSignal.value,
      unavailabilities,
      constraints: constraintsSignal.value.filter(item => !item.configId || item.configId === config.id),
      template: draft.sessions.map(session => ({
        date: session.date,
        presentations: session.presentations.map(presentation => ({
          presenterId: presentation.presenter.kind === 'fixed' ? presentation.presenter.personId : null,
          questionerIds: presentation.questioners.map(slot => slot.kind === 'fixed' ? slot.personId : null),
        })),
      })),
    });
  }

  async function commitManualEdit(): Promise<void> {
    if (!draftSchedule || !selectedConfig) return;
    try {
      const createdAt = Date.now();
      const sessions = solveDraft(draftSchedule, selectedConfig);
      const updated: SchedulePlan = {
        id: crypto.randomUUID(),
        createdAt,
        modifiedAt: createdAt,
        configId: draftSchedule.configId,
        sessions,
        sessionMutations: draftSchedule.sessionMutations,
        sessionDateMeta: buildSessionDateMeta(sessions, draftSchedule.sessionMutations, draftSchedule.sessionDateMeta),
        notes: `${draftSchedule.notes ?? current?.notes ?? ''}\n[batch-edit] committed=${new Date(createdAt).toISOString()}`.trim(),
      };
      await db.schedules.put(updated);
      if (await refreshScheduleScopedData(updated.configId)) currentScheduleSignal.value = updated;
      setDraftSchedule(null);
      setManualEditMode(false);
      setUndoStack([]);
      setRedoStack([]);
      maybeShowLocalMetrics(updated, t('metricsAfterMutationTitle'));
    } catch (err) {
      toast.error(String(err));
    }
  }

  /**
   * Always computes metrics locally (used for mutation feedback and as a
   * fallback after a solve, regardless of deployment mode).
   */
  function localMetricsForPlan(plan: SchedulePlan) {
    const config = configs.find(c => c.id === plan.configId);
    if (!config) return null;
    const constraints = constraintsSignal.value.filter(item => !item.configId || item.configId === config.id);
    const metrics = computeScheduleMetrics(plan, {
      persons,
      similarities: similarityLookupSignal.value,
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

  async function refreshScheduleScopedData(configId: string): Promise<boolean> {
    const foreignKeys = await readScheduleForeignKeys(db, [configId]);
    if (selectedConfigIdRef.current !== configId) return false;
    batch(() => {
      constraintsSignal.value = foreignKeys.constraints;
      schedulesSignal.value = foreignKeys.schedules;
      unavailabilitiesSignal.value = foreignKeys.unavailabilities;
    });
    return true;
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
    if (await refreshScheduleScopedData(planWithMeta.configId)) {
      currentScheduleSignal.value = { ...planWithMeta, modifiedAt: Date.now() };
    }
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
    const config = configs.find(c => c.id === plan.configId);
    if (!config) return;
    const { metrics, explanations } = await backend.computeMetricsForPlan(plan, config, solverCtx(config.id));
    openMetricsDialog(`${t('historyTitle')} · ${new Date(plan.createdAt).toLocaleString()}`, metrics, explanations);
  }

  async function showMetricsForSession(plan: SchedulePlan, sessionDate: string): Promise<void> {
    const config = configs.find(c => c.id === plan.configId);
    if (!config) return;
    const sessionIndex = plan.sessions.findIndex(session => session.date === sessionDate);
    if (sessionIndex < 0) return;
    const { metrics, explanations } = await backend.computeMetricsForSession(plan, sessionDate, config, solverCtx(config.id));
    openMetricsDialog(`${sessionDate} · ${t('sessionDate')}`, metrics, explanations);
  }

  // #endregion

  // #region Config

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put({ ...c, modifiedAt: Date.now() });
    configsSignal.value = await readAllPaginated(db.configs);
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
      const result = await backend.runFull(config, solverCtx(config.id));
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
      const result = await backend.runIncremental(config, current, changeDate, solverCtx(config.id), incrementalMode);
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
    copiedTsv.value = true;
    window.setTimeout(() => { copiedTsv.value = false; }, 1500);
  }

  async function handleCopyHtml() {
    if (!current) return;
    await copyScheduleHtml(current, personMap, displayName);
    copiedHtml.value = true;
    window.setTimeout(() => { copiedHtml.value = false; }, 1500);
  }

  async function handleCopyCsv() {
    if (!current) return;
    await copyScheduleCsv(current, personMap, displayName);
    copiedCsv.value = true;
    window.setTimeout(() => { copiedCsv.value = false; }, 1500);
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
      if (!await refreshScheduleScopedData(plan.configId)) return;
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
      if (!await refreshScheduleScopedData(selectedConfigId)) return;
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
    if (await refreshScheduleScopedData(plan.configId) && currentScheduleSignal.value?.id === plan.id) {
      currentScheduleSignal.value = updated;
    }
  }

  async function handleDuplicateHistory(plan: SchedulePlan) {
    const timestamp = Date.now();
    const duplicate: SchedulePlan = {
      ...plan,
      id: crypto.randomUUID(),
      createdAt: timestamp,
      modifiedAt: timestamp,
    };

    await db.schedules.put(duplicate);
    if (await refreshScheduleScopedData(duplicate.configId)) currentScheduleSignal.value = duplicate;
  }

  function handleMoveQuestioner(sourcePresentationId: string, slotId: string, targetPresentationId: string, targetIndex: number): void {
    updateDraft((draft) => {
      const source = [...draft.discardedBefore, ...draft.sessions.flatMap(session => session.presentations), ...draft.discardedAfter]
        .find(presentation => presentation.id === sourcePresentationId);
      const slot = source?.questioners.find(item => item.id === slotId);
      if (slot?.kind === 'fixed' && !isQuestionerPlacementValid(draft, targetPresentationId, slot.personId)) {
        toast.error(t('invalidQuestionerDrop'));
        return draft;
      }
      return moveQuestioner(draft, sourcePresentationId, slotId, targetPresentationId, targetIndex);
    });
  }

  function handleMoveBoundaryTo(boundaryIndex: number, targetSessionIndex: number, targetPresentationIndex: number): void {
    updateDraft((draft) => {
      let next = draft;
      if (targetSessionIndex === boundaryIndex) {
        for (let step = 0; step < targetPresentationIndex; step += 1) next = moveBoundary(next, boundaryIndex, 'down');
        return next;
      }
      if (targetSessionIndex === boundaryIndex - 1) {
        const previousLength = draft.sessions[targetSessionIndex]?.presentations.length ?? 0;
        for (let step = targetPresentationIndex; step < previousLength; step += 1) next = moveBoundary(next, boundaryIndex, 'up');
        return next;
      }
      toast.error(t('boundaryAdjacentOnly'));
      return draft;
    });
  }

  function openInsertSession(index: number): void {
    setInsertSessionIndex(index);
    setInsertedSessionDate('');
  }

  function applyInsertSession(): void {
    if (insertSessionIndex === null || !draftSchedule || !selectedConfig) return;
    const date = insertedSessionDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast.error(t('mutationInsertedDateRequired'));
      return;
    }
    if (date < selectedConfig.startDate || date > selectedConfig.endDate) {
      toast.error(t('mutationDateOutOfRange', selectedConfig.startDate, selectedConfig.endDate));
      return;
    }
    if (draftSchedule.sessions.some(session => session.date === date)) {
      toast.error(t('mutationInsertedDateOverlap', date));
      return;
    }
    updateDraft((draft) => {
      const next = insertSession(
        draft,
        insertSessionIndex,
        date,
        selectedConfig.presentersPerSession,
        selectedConfig.questionersPerPresenter,
      );
      next.sessionMutations = [
        ...(draft.sessionMutations ?? []).filter(mutation => mutation.date !== date),
        { date, action: 'insert' as const, createdAt: Date.now() },
      ].sort((left, right) => left.date.localeCompare(right.date));
      return next;
    });
    setInsertSessionIndex(null);
    setInsertedSessionDate('');
  }

  function handleDeleteSession(sessionId: string): void {
    updateDraft((draft) => {
      const session = draft.sessions.find(item => item.id === sessionId);
      if (!session) return draft;
      const next = deleteSession(draft, sessionId);
      const existing = draft.sessionMutations ?? [];
      next.sessionMutations = existing.some(mutation => mutation.date === session.date && mutation.action === 'insert')
        ? existing.filter(mutation => mutation.date !== session.date)
        : [...existing.filter(mutation => mutation.date !== session.date), { date: session.date, action: 'delete' as const, createdAt: Date.now() }]
          .sort((left, right) => left.date.localeCompare(right.date));
      return next;
    });
  }

  // #endregion

  // #region Unavailabilities

  async function handleSaveUnavail(u: PersonUnavailability) {
    await db.unavailabilities.put(u);
    await refreshScheduleScopedData(u.configId);
    setShowUnavailForm(false);
    setEditingUnavail(null);
  }

  async function handleDeleteUnavail(id: string) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      try {
        await db.unavailabilities.delete(id);
        await refreshScheduleScopedData(selectedConfigId);
      } catch (err) {
        toast.error(`${t('computeError')}: ${String(err)}`);
      }
    });
  }

  // #endregion

  // #region Render

  if (baseStatus === 'idle' || baseStatus === 'pending') return <ContentSkeleton rows={8} />;
  if (baseStatus === 'error') return <div role="alert" class={s.card}>
    <p class={s.textDanger}>{String(baseError)}</p>
    <Button variant="secondary" onClick={() => setBaseRevision(value => value + 1)}>{t('retry')}</Button>
  </div>;
  if (selectedConfigId && scopedStatus !== 'success') {
    return scopedStatus === 'error' ? <div role="alert" class={s.card}>
      <p class={s.textDanger}>{String(scopedState.error)}</p>
      <Button variant="secondary" onClick={() => setScopeRevision(value => value + 1)}>{t('retry')}</Button>
    </div> : <ContentSkeleton rows={8} />;
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navSchedule')}</h2>
        <div class={s.flexGapSm}>
          {!manualEditMode ? (
            <Button variant="ghost" onClick={beginManualEdit} disabled={!current}>
              <Pencil size={14} />
              {t('manualEdit')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={undoDraft} disabled={undoStack.length === 0} title={t('undo')}>
                <Undo2 size={14} />
              </Button>
              <Button variant="ghost" onClick={redoDraft} disabled={redoStack.length === 0} title={t('redo')}>
                <Redo2 size={14} />
              </Button>
              <Button variant="primary" onClick={() => void commitManualEdit()}>
                {t('commitManualEdits')}
              </Button>
              <Button variant="secondary" onClick={cancelManualEdit}>
                {t('cancelManualEdits')}
              </Button>
              <span class={`${s.text12} ${draftSchedule && discardedPresentationCount(draftSchedule) > 0 ? s.textDanger : s.textMuted}`}>
                {draftSchedule && discardedPresentationCount(draftSchedule) > 0
                  ? t('commitDiscardWarning', String(discardedPresentationCount(draftSchedule)))
                  : t('manualEditDraftMode')}
              </span>
            </>
          )}
        </div>
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
            configsSignal.value = await readAllPaginated(db.configs);
            setSelectedConfigId('');
          });
        }}
          onAddUnavail={() => {
            setEditingUnavail(null);
            setShowUnavailForm(true);
          }}
          onEditUnavail={(u) => {
            setEditingUnavail(u);
            setShowUnavailForm(true);
          }}
        onDeleteUnavail={handleDeleteUnavail}
        showUnavailForm={showUnavailForm}
          editingUnavail={editingUnavail}
          onCloseUnavailForm={() => {
            setShowUnavailForm(false);
            setEditingUnavail(null);
          }}
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
            <select
              class={`${s.input} ${s.autoWidthInput}`}
              value={incrementalMode}
              onChange={event => setIncrementalMode((event.target as HTMLSelectElement).value as IncrementalSolveMode)}
            >
              <option value="full">{t('incrementalModeFull')}</option>
              <option value="questioners-only">{t('incrementalModeQuestionersOnly')}</option>
            </select>
            <Button variant="secondary" onClick={handleIncremental} disabled={isComputing || !changeDate}>
              {t('incrementalReschedule')}
            </Button>
          </>
        )}
      </div>

      {/* Copy / Export row */}
      {current && (
        <div class={`${s.toolbar} ${s.mb24}`}>
          <Button variant="secondary" onClick={handleCopyTsv}>{copiedTsv.value ? `✓ ${t('copyToClipboard')}` : t('copyToClipboard')}</Button>
          <Button variant="secondary" onClick={handleCopyHtml}>{copiedHtml.value ? `✓ ${t('copyAsHtml')}` : t('copyAsHtml')}</Button>
          <Button variant="secondary" onClick={handleCopyCsv}>{copiedCsv.value ? `✓ ${t('copyAsCsv')}` : t('copyAsCsv')}</Button>
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
          onSelectHistory={plan => { cancelManualEdit(); currentScheduleSignal.value = plan; }}
          onDuplicateHistory={(plan) => void handleDuplicateHistory(plan)}
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
      <MetricsDialog state={metricsDialog} onClose={() => setMetricsDialog(null)} />
      <InsertSessionDialog
        open={insertSessionIndex !== null}
        insertedSessionDate={insertedSessionDate}
        minDate={selectedConfig?.startDate}
        maxDate={selectedConfig?.endDate}
        onInsertedDateChange={setInsertedSessionDate}
        onApply={applyInsertSession}
        onClose={() => setInsertSessionIndex(null)}
      />

      {/* Direct schedule tape */}
      <div class={s.toolbar}>
        <label class={s.label}>{t('highlightPerson')}
          <select class={s.input} value={highlightPersonId} onChange={event => setHighlightPersonId((event.target as HTMLSelectElement).value)}>
            <option value="">{t('none')}</option>
            {persons.map(person => <option key={person.id} value={person.id}>{displayName(person)}</option>)}
          </select>
        </label>
        <label class={s.label}>{t('highlightPersonTag')}
          <select class={s.input} value={highlightTagId} onChange={event => setHighlightTagId((event.target as HTMLSelectElement).value)}>
            <option value="">{t('none')}</option>
            {personTagsSignal.value.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </label>
      </div>
      <ScheduleView
        draft={visibleDraft}
        personMap={personMap}
        similarities={similarityLookupSignal.value}
        manualEditMode={manualEditMode}
        highlightPersonIds={highlightedPersonIds}
        onInsertPresentation={(sessionIndex, presentationIndex) => {
          if (!selectedConfig) return;
          updateDraft(draft => insertPresentation(draft, sessionIndex, presentationIndex, selectedConfig.questionersPerPresenter));
        }}
        onDeletePresentation={presentationId => updateDraft(draft => deletePresentation(draft, presentationId))}
        onReplacePresenter={(presentationId, personId) => updateDraft(draft => replacePresenter(draft, presentationId, personId))}
        onAddQuestioner={(presentationId, personId) => updateDraft(draft => addQuestioner(draft, presentationId, personId))}
        onReplaceQuestioner={(presentationId, slotId, personId) => updateDraft(draft => replaceQuestioner(draft, presentationId, slotId, personId))}
        onDeleteQuestioner={(presentationId, slotId) => updateDraft(draft => deleteQuestioner(draft, presentationId, slotId))}
        onMoveQuestioner={handleMoveQuestioner}
        onReorderPresentations={(sourceId, targetId, placement) => updateDraft(draft => reorderPresentations(draft, sourceId, targetId, placement))}
        onMovePresentationTo={(sourceId, targetSessionIndex, targetPresentationIndex) => updateDraft(draft => movePresentationTo(draft, sourceId, targetSessionIndex, targetPresentationIndex))}
        onMoveBoundary={(sessionIndex, direction) => updateDraft(draft => moveBoundary(draft, sessionIndex, direction))}
        onMoveBoundaryTo={handleMoveBoundaryTo}
        onShiftSuffix={(sessionIndex, direction) => {
          if (!selectedConfig) return;
          updateDraft(draft => shiftSessionSuffix(draft, sessionIndex, direction, selectedConfig.questionersPerPresenter));
        }}
        onInsertSession={openInsertSession}
        onDeleteSession={handleDeleteSession}
        onShowMetricsForSession={date => {
          if (!manualEditMode && current) {
            void showMetricsForSession(current, date);
            return;
          }
          if (!draftSchedule || !selectedConfig) return;
          try {
            const preview: SchedulePlan = {
              id: draftSchedule.id,
              createdAt: draftSchedule.createdAt,
              configId: draftSchedule.configId,
              sessions: solveDraft(draftSchedule, selectedConfig),
            };
            const local = localMetricsForPlan({ ...preview, sessions: preview.sessions.filter(session => session.date === date) });
            if (local) openMetricsDialog(`${date} · ${t('draftMetrics')}`, local.metrics, local.explanations);
          } catch (error) {
            toast.error(String(error));
          }
        }}
      />
    </div>
  );

  // #endregion
}
