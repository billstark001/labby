import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useForm, useSelector } from '@tanstack/preact-form';
import {
  EMAIL_TASK_TIMEZONE_SCHEDULE,
  EMAIL_TASK_TIMEZONE_SYSTEM,
  SYSTEM_DEFAULT_TIMEZONE,
  buildEmailTemplateScheduleVariables,
  buildScheduleIcs,
  getEnvironmentTimeZone,
  normalizeTimeZone,
  renderTemplate,
  renderTemplateToHtml,
  type EmailTask,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
} from '@labby/core';
import { toast } from '@/components/ui';
import { confirmDialog } from '@/components/ui/Dialog';
import { useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { sendEmailTaskNow, setEmailTaskSkipNext } from '@/api-server/email-tasks';
import { getEmailTaskCapability } from '@/lib/email-task-capability';
import { getPublicEmailTaskIcsUrl } from '@/lib/email-task-ics';
import { navigate, registerNavigationGuard } from '@/lib/router';
import { usePendingAction } from '@/lib/use-pending-action';
import { emptyEmailTaskFormValues, emailTaskFormValuesFromTask, type EmailTaskFormValues } from './emailTaskFormValues';

export const DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function parseEmails(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatPreviewDateTime(locale: string, timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(now);
}

export type EmailTaskEditorProps = {
  taskId?: string;
  task: EmailTask | undefined;
  configs: ScheduleConfig[];
  persons: Person[];
  schedules: SchedulePlan[];
  systemTimezone: string | undefined;
};

export function useEmailTaskEditor({ taskId, task, configs, persons, schedules, systemTimezone: initialSystemTimezone }: EmailTaskEditorProps) {
  const { t } = i18n;
  const db = useDatabase();
  const action = usePendingAction();
  const capability = getEmailTaskCapability();
  const [currentTask, setCurrentTask] = useState(task);
  const [ready, setReady] = useState(false);

  const [selectedTaskId, setSelectedTaskId] = useState<string>(taskId ?? '');
  const draftTaskIdRef = useRef(taskId ?? crypto.randomUUID());
  const [initialConfigId] = useState(() => {
    let rememberedConfigId: string | null = null;
    try { rememberedConfigId = localStorage.getItem('schedule.lastSelectedConfigId'); } catch { /* Storage may be unavailable. */ }
    return configs.find(config => config.id === rememberedConfigId)?.id ?? configs[0]?.id ?? '';
  });
  const savingRef = useRef(false);
  const defaultValuesRef = useRef(task
    ? emailTaskFormValuesFromTask(task, i18n.lang.value)
    : emptyEmailTaskFormValues(initialConfigId, i18n.lang.value));
  const form = useForm({
    defaultValues: defaultValuesRef.current,
  });
  function resetToValues(nextValues: EmailTaskFormValues): void {
    defaultValuesRef.current = structuredClone(nextValues);
    setSavedValues(defaultValuesRef.current);
    form.reset(structuredClone(nextValues));
  }
  const values = useSelector(form.store, (state) => state.values);
  const [savedValues, setSavedValues] = useState(defaultValuesRef.current);
  const isDirty = JSON.stringify(values) !== JSON.stringify(savedValues);
  const hasUnsavedChanges = () => JSON.stringify(form.state.values) !== JSON.stringify(defaultValuesRef.current);
  const {
    configId, taskTimezone, templateText, templateFormat, injectionLanguage, dateGranularity,
    subjectTemplate, senderNameTemplate, attachmentTypes, icsLinkMode, icsContentTemplate,
    serveScheduleIcs,
  } = values;

  const systemTimezone = initialSystemTimezone;
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [showIcsPreviewDialog, setShowIcsPreviewDialog] = useState(false);
  const [icsPreview, setIcsPreview] = useState({ text: '', error: '' });
  const [sendNowOpen, setSendNowOpen] = useState(false);
  const [sendRecipientsText, setSendRecipientsText] = useState('');
  const [sendingNow, setSendingNow] = useState(false);
  const [sendNowError, setSendNowError] = useState('');
  const [showDaysDialog, setShowDaysDialog] = useState(false);
  const [showVarDialog, setShowVarDialog] = useState(false);
  const [varDialogSource, setVarDialogSource] = useState<'email' | 'ics'>('email');
  const [showAttachmentDialog, setShowAttachmentDialog] = useState(false);
  const [docLanguage, setDocLanguage] = useState<'en' | 'zh-CN' | 'ja-JP'>(i18n.lang.value);

  const selectedConfig = useMemo(
    () => configs.find((item) => item.id === configId),
    [configs, configId],
  );

  const latestScheduleForConfig = useMemo(
    () => [...schedules]
      .filter((item) => item.configId === configId)
      .sort((left, right) => right.createdAt - left.createdAt)[0],
    [schedules, configId],
  );

  const resolvedPreviewTimezone = useMemo(() => {
    const systemOrEnv = normalizeTimeZone(systemTimezone) ?? getEnvironmentTimeZone();
    if (taskTimezone === EMAIL_TASK_TIMEZONE_SYSTEM) return systemOrEnv;
    if (taskTimezone === EMAIL_TASK_TIMEZONE_SCHEDULE) {
      return normalizeTimeZone(selectedConfig?.timezone) ?? systemOrEnv;
    }
    if (taskTimezone === SYSTEM_DEFAULT_TIMEZONE) {
      return normalizeTimeZone(selectedConfig?.timezone) ?? systemOrEnv;
    }
    return normalizeTimeZone(taskTimezone) ?? normalizeTimeZone(selectedConfig?.timezone) ?? systemOrEnv;
  }, [taskTimezone, selectedConfig, systemTimezone]);
  const resolvedPreviewScheduleTimezone = normalizeTimeZone(selectedConfig?.timezone)
    ?? normalizeTimeZone(systemTimezone) ?? getEnvironmentTimeZone();

  const [previewTime, setPreviewTime] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setPreviewTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const injectedScheduleVariables = useMemo(
    () => buildEmailTemplateScheduleVariables({
      plan: latestScheduleForConfig,
      persons,
      config: selectedConfig,
      locale: injectionLanguage,
      granularity: dateGranularity,
      anchorTime: previewTime,
      timeZone: resolvedPreviewScheduleTimezone,
    }),
    [latestScheduleForConfig, persons, selectedConfig, injectionLanguage, dateGranularity, resolvedPreviewScheduleTimezone, previewTime],
  );

  const previewContext = useMemo(() => {
    const now = new Date(previewTime);
    const nowLocal = formatPreviewDateTime(injectionLanguage, resolvedPreviewTimezone, now);
    return {
      recipient: 'preview@example.com',
      configId: configId || 'config-preview',
      taskId: selectedTaskId || 'task-preview',
      now: nowLocal,
      nowIsoUtc: now.toISOString(),
      nowLocal,
      runTimezone: resolvedPreviewTimezone,
      sessionCount: latestScheduleForConfig?.sessions.length ?? 0,
      latestCreatedAt: latestScheduleForConfig?.createdAt ?? null,
      summary: 'This is a local preview. In frontend-only mode, emails are not auto-sent.',
      language: injectionLanguage,
      scheduleIcsUrl: serveScheduleIcs && selectedTaskId ? getPublicEmailTaskIcsUrl(selectedTaskId) : undefined,
      ...injectedScheduleVariables,
    };
  }, [configId, selectedTaskId, injectionLanguage, resolvedPreviewTimezone, serveScheduleIcs, injectedScheduleVariables, previewTime, latestScheduleForConfig]);

  const previewResult = useMemo(
    () => renderTemplateToHtml(templateText, previewContext, { format: templateFormat }),
    [templateText, previewContext, templateFormat],
  );

  const previewSubject = useMemo(
    () => renderTemplate(subjectTemplate || t('emailTaskDefaultSubject'), previewContext),
    [subjectTemplate, previewContext, t],
  );

  const previewSenderName = useMemo(
    () => senderNameTemplate ? renderTemplate(senderNameTemplate, previewContext) : { output: '', errors: [] },
    [senderNameTemplate, previewContext],
  );

  function applyTaskToForm(task: EmailTask): void {
    draftTaskIdRef.current = task.id;
    setSelectedTaskId(task.id);
    resetToValues(emailTaskFormValuesFromTask(task, i18n.lang.value));
  }

  function resetForm(nextConfigId?: string): void {
    draftTaskIdRef.current = crypto.randomUUID();
    setSelectedTaskId('');
    resetToValues(emptyEmailTaskFormValues(nextConfigId ?? configs[0]?.id ?? '', i18n.lang.value));
  }

  useEffect(() => {
    if (task) applyTaskToForm(task);
    else resetForm(initialConfigId);
    setReady(true);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges() && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const unregister = registerNavigationGuard((_path, proceed) => {
      if (savingRef.current) return false;
      if (!hasUnsavedChanges()) return true;
      confirmDialog(t('unsavedChangesWarning'), '', proceed, undefined, t('confirm'));
      return false;
    });
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  async function saveTask(): Promise<void> {
    if (savingRef.current) return;
    const snapshot = structuredClone(form.state.values);
    const {
      configId, isDisabled, selectedDays, sendTime, taskTimezone, emailsText, recentTimes,
      senderNameTemplate, subjectTemplate, templateText, templateFormat, injectionLanguage,
      dateGranularity, notes, serveScheduleIcs, icsLinkMode, icsContentTemplate, attachmentTypes,
    } = snapshot;
    if (!configId || !configs.some(config => config.id === configId)) throw new Error(t('selectConfigFirst'));
    if (!Number.isSafeInteger(recentTimes) || recentTimes < 0 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
      throw new Error(t('emailTaskInvalidSettings'));
    }
    savingRef.current = true;
    try {
      const existing = selectedTaskId ? await db.emailTasks.get(selectedTaskId) : undefined;
      if (selectedTaskId && !existing) throw new Error(t('emailTaskNotFound'));
      const nextId = selectedTaskId || draftTaskIdRef.current;
      const timezoneSource = taskTimezone === EMAIL_TASK_TIMEZONE_SCHEDULE
        ? 'schedule'
        : taskTimezone === EMAIL_TASK_TIMEZONE_SYSTEM
          ? 'system'
          : taskTimezone === SYSTEM_DEFAULT_TIMEZONE
            ? 'default'
            : 'task';
      const explicitTimezone = timezoneSource === 'task' ? taskTimezone : undefined;
      const savedTask: EmailTask = {
        ...existing,
        id: nextId,
        configId,
        disabled: isDisabled,
        notes: notes.trim() || undefined,
        daysOfWeek: [...selectedDays].sort((a, b) => a - b),
        sendTime,
        timezone: explicitTimezone,
        emails: parseEmails(emailsText),
        recentTimes,
        senderNameTemplate,
        subjectTemplate,
        templateText,
        modifiedAt: Date.now(),
        metadata: {
          ...existing?.metadata,
          format: templateFormat,
          injectionLanguage,
          dateGranularity,
          dateLocale: injectionLanguage,
          serveScheduleIcs,
          icsLinkMode,
          icsContentTemplate,
          attachmentTypes,
          timezone: explicitTimezone,
          timezoneSource,
          sendTime,
        },
      };
      await db.emailTasks.put(savedTask);
      setCurrentTask(savedTask);
      const liveValues = structuredClone(form.state.values);
      resetToValues(snapshot);
      // Retain edits made while the request was pending, with the saved snapshot as baseline.
      for (const key of Object.keys(snapshot) as (keyof EmailTaskFormValues)[]) {
        if (JSON.stringify(liveValues[key]) !== JSON.stringify(snapshot[key])) {
          form.setFieldValue(key, liveValues[key]);
        }
      }
      setSelectedTaskId(nextId);
      toast.success(t('emailTaskSaved'));
      savingRef.current = false;
      if (!hasUnsavedChanges()) navigate(`/email-tasks/edit/${nextId}`);
    } finally {
      savingRef.current = false;
    }
  }

  async function removeTask(): Promise<void> {
    if (!selectedTaskId) return;
    await db.emailTasks.delete(selectedTaskId);
    resetToValues(form.state.values);
    navigate('/email-tasks');
  }

  async function copyNextEmail(): Promise<void> {
    await navigator.clipboard.writeText(previewResult.html);
    toast.success(t('emailTaskPreviewCopied'));
  }

  async function copyPublicIcsLink(): Promise<void> {
    if (!selectedTaskId) return;
    await navigator.clipboard.writeText(getPublicEmailTaskIcsUrl(selectedTaskId));
    toast.success(t('emailTaskIcsLinkCopied'));
  }

  async function triggerSendNow(): Promise<void> {
    if (!selectedTaskId || !capability.canAutoSend || sendingNow) return;
    const recipients = [...new Set(parseEmails(sendRecipientsText))];
    if (recipients.length === 0 || recipients.some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
      setSendNowError(t('emailTaskInvalidRecipients'));
      return;
    }
    setSendingNow(true);
    setSendNowError('');
    try {
      const result = await sendEmailTaskNow(selectedTaskId, recipients);
      toast.success(t('emailTaskSendNowSuccessCount', String(result.sent)));
      if (result.failed > 0) toast.warning(t('emailTaskSendNowPartial', String(result.failed)));
      setSendNowOpen(false);
    } catch (err) {
      setSendNowError(`${t('emailTaskSendNowFailed')}: ${String(err)}`);
    } finally {
      setSendingNow(false);
    }
  }

  async function toggleSkipNext(): Promise<void> {
    if (!selectedTaskId || !capability.canAutoSend) return;
    const current = currentTask;
    const nextSkip = !(current?.skipNextRun ?? false);
    try {
      await setEmailTaskSkipNext(selectedTaskId, nextSkip);
      setCurrentTask(await db.emailTasks.get(selectedTaskId));
      toast.success(nextSkip ? t('emailTaskSkipNextEnabled') : t('emailTaskSkipNextDisabled'));
    } catch (err) {
      toast.error(`${t('emailTaskSkipNextFailed')}: ${String(err)}`);
    }
  }

  const attachmentSummary = useMemo(() => {
    if (attachmentTypes.length === 0) return t('noneSelected');
    return attachmentTypes.map((type) => {
      if (type === 'schedule-semester-csv') return t('emailTaskAttachmentCsv');
      return t('emailTaskAttachmentIcs');
    }).join(', ');
  }, [attachmentTypes, t]);

  async function toggleDisabled(): Promise<void> {
    const current = selectedTaskId ? await db.emailTasks.get(selectedTaskId) : undefined;
    if (!current) return;
    const nextDisabled = !current.disabled;
    await db.emailTasks.put({ ...current, disabled: nextDisabled, modifiedAt: Date.now() });
    setCurrentTask(await db.emailTasks.get(selectedTaskId));
    const liveValues = structuredClone(form.state.values);
    resetToValues({ ...defaultValuesRef.current, isDisabled: nextDisabled });
    for (const key of Object.keys(liveValues) as (keyof EmailTaskFormValues)[]) {
      if (key !== 'isDisabled') form.setFieldValue(key, liveValues[key]);
    }
  }

  function toggleDay(day: number): void {
    form.setFieldValue('selectedDays', (previous) => previous.includes(day)
      ? previous.filter((value) => value !== day)
      : [...previous, day].sort((a, b) => a - b));
  }

  function insertScheduleTableSnippet(): void {
    const snippet = form.state.values.templateFormat === 'html'
      ? '{{ schedule.tableHtml() }}'
      : '{{ schedule.tableMarkdown() }}';
    form.setFieldValue('templateText', previous => `${previous}\n\n${snippet}`.trim());
  }

  function insertIcsLinkSnippet(): void {
    const label = t('emailTaskIcsLinkLabel');
    if (form.state.values.templateFormat === 'html') {
      form.setFieldValue('templateText', (previous) => `${previous}\n\n<p><a href="{{ scheduleIcsUrl }}">${label}</a></p>`.trim());
      return;
    }
    form.setFieldValue('templateText', (previous) => `${previous}\n\n[${label}]({{ scheduleIcsUrl }})`.trim());
  }

  function openVariableReference(source: 'email' | 'ics'): void {
    setVarDialogSource(source);
    setDocLanguage(i18n.lang.value);
    setShowVarDialog(true);
  }

  function openIcsPreview(): void {
    if (!latestScheduleForConfig) {
      setIcsPreview({ text: '', error: t('emailTaskIcsPreviewNoSchedule') });
    } else {
      try {
        const personMap = new Map(persons.map((person) => [person.id, person]));
        const labels = injectionLanguage === 'zh-CN'
          ? { presenter: '主讲', questioners: '提问', meeting: '组会' }
          : injectionLanguage === 'ja-JP'
            ? { presenter: '発表者', questioners: '質問者', meeting: 'グループミーティング' }
            : { presenter: 'Presenter', questioners: 'Questioners', meeting: 'Group meeting' };
        const text = buildScheduleIcs(latestScheduleForConfig, personMap, (person) => person.name?.trim() || Object.values(person.names ?? {}).find((name) => name.trim()) || `ID:${person.id}`, selectedConfig, labels, {
          timeZone: resolvedPreviewScheduleTimezone,
          mode: icsLinkMode,
          contentTemplate: icsContentTemplate,
          templateContext: {
            taskId: selectedTaskId || 'task-preview',
            configId: configId || 'config-preview',
            scheduleIcsUrl: serveScheduleIcs && selectedTaskId ? getPublicEmailTaskIcsUrl(selectedTaskId) : undefined,
            ...injectedScheduleVariables,
          },
        });
        setIcsPreview({ text, error: '' });
      } catch (error) {
        setIcsPreview({ text: '', error: error instanceof Error ? error.message : String(error) });
      }
    }
    setShowIcsPreviewDialog(true);
  }

  return {
    t, action, capability, currentTask, ready, selectedTaskId, form, values, isDirty,
    showPreviewDialog, setShowPreviewDialog, showIcsPreviewDialog, setShowIcsPreviewDialog, icsPreview,
    sendNowOpen, setSendNowOpen, sendRecipientsText, setSendRecipientsText, sendingNow, sendNowError, setSendNowError,
    showDaysDialog, setShowDaysDialog, showVarDialog, setShowVarDialog, varDialogSource,
    showAttachmentDialog, setShowAttachmentDialog, docLanguage, setDocLanguage,
    configs, resolvedPreviewTimezone, previewResult, previewSubject, previewSenderName, attachmentSummary,
    applyTaskToForm, resetForm, saveTask, removeTask, copyNextEmail, copyPublicIcsLink,
    triggerSendNow, toggleSkipNext, toggleDisabled, toggleDay, insertScheduleTableSnippet,
    insertIcsLinkSnippet, openVariableReference, openIcsPreview,
  };
}
