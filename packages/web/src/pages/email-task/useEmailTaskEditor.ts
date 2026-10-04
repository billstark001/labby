import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_TEMPLATE_PRESETS,
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
  type ScheduleDateGranularity,
  type ScheduleIcsMode,
  type TemplateFormat,
} from '@labby/core';
import { toast } from '@/components/ui';
import { confirmDialog } from '@/components/ui/Dialog';
import { useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { sendEmailTaskNow, setEmailTaskSkipNext } from '@/api-server/email-tasks';
import { getEmailTaskCapability } from '@/lib/email-task-capability';
import { getPublicEmailTaskIcsUrl } from '@/lib/email-task-ics';
import { navigate } from '@/lib/router';
import { usePendingAction } from '@/lib/use-pending-action';
import type { EmailAttachmentType } from './AttachmentSettingsDialog';

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
  const [configId, setConfigId] = useState('');
  const [isDisabled, setIsDisabled] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 3, 5]);
  const [sendTime, setSendTime] = useState('09:00');
  const [taskTimezone, setTaskTimezone] = useState(SYSTEM_DEFAULT_TIMEZONE);
  const systemTimezone = initialSystemTimezone;
  const [emailsText, setEmailsText] = useState('');
  const [recentTimes, setRecentTimes] = useState(0);
  const [senderNameTemplate, setSenderNameTemplate] = useState('');
  const [subjectTemplate, setSubjectTemplate] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [templateFormat, setTemplateFormat] = useState<TemplateFormat>('markdown');
  const [injectionLanguage, setInjectionLanguage] = useState<'en' | 'zh-CN' | 'ja-JP'>(i18n.lang.value);
  const [dateGranularity, setDateGranularity] = useState<ScheduleDateGranularity>('date');
  const [notes, setNotes] = useState('');
  const [serveScheduleIcs, setServeScheduleIcs] = useState(false);
  const [icsLinkMode, setIcsLinkMode] = useState<ScheduleIcsMode>('presenters');
  const [icsContentTemplate, setIcsContentTemplate] = useState('');
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
  const [isDirty, setIsDirty] = useState(false);
  const [attachmentTypes, setAttachmentTypes] = useState<EmailAttachmentType[]>([
    'schedule-semester-csv',
    'schedule-semester-ics',
  ]);

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

  const injectedScheduleVariables = useMemo(
    () => buildEmailTemplateScheduleVariables({
      plan: latestScheduleForConfig,
      persons,
      config: selectedConfig,
      locale: injectionLanguage,
      granularity: dateGranularity,
      anchorDate: new Intl.DateTimeFormat('en-CA', {
        timeZone: resolvedPreviewScheduleTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
      timeZone: resolvedPreviewScheduleTimezone,
    }),
    [latestScheduleForConfig, persons, selectedConfig, injectionLanguage, dateGranularity, resolvedPreviewScheduleTimezone],
  );

  const previewContext = useMemo(() => {
    const now = new Date();
    const nowLocal = formatPreviewDateTime(injectionLanguage, resolvedPreviewTimezone, now);
    return {
      recipient: 'preview@example.com',
      configId: configId || 'config-preview',
      taskId: selectedTaskId || 'task-preview',
      now: nowLocal,
      nowIsoUtc: now.toISOString(),
      nowLocal,
      runTimezone: resolvedPreviewTimezone,
      sessionCount: 4,
      summary: 'This is a local preview. In frontend-only mode, emails are not auto-sent.',
      language: injectionLanguage,
      scheduleIcsUrl: serveScheduleIcs && selectedTaskId ? getPublicEmailTaskIcsUrl(selectedTaskId) : undefined,
      ...injectedScheduleVariables,
    };
  }, [configId, selectedTaskId, injectionLanguage, resolvedPreviewTimezone, serveScheduleIcs, injectedScheduleVariables]);

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
    setSelectedTaskId(task.id);
    setConfigId(task.configId);
    setIsDisabled(task.disabled ?? false);
    setSelectedDays(task.daysOfWeek);
    setSendTime(task.sendTime ?? '09:00');
    const timezoneSource = task.metadata?.timezoneSource;
    if (timezoneSource === 'schedule') {
      setTaskTimezone(EMAIL_TASK_TIMEZONE_SCHEDULE);
    } else if (timezoneSource === 'system') {
      setTaskTimezone(EMAIL_TASK_TIMEZONE_SYSTEM);
    } else {
      setTaskTimezone(task.timezone ?? (typeof task.metadata?.timezone === 'string' ? task.metadata.timezone : SYSTEM_DEFAULT_TIMEZONE));
    }
    setEmailsText(task.emails.join(', '));
    setRecentTimes(task.recentTimes);
    setSenderNameTemplate(task.senderNameTemplate ?? '');
    setSubjectTemplate(task.subjectTemplate ?? '');
    setTemplateText(task.templateText);
    setTemplateFormat(((task.metadata?.format as TemplateFormat | undefined) ?? 'markdown'));
    setInjectionLanguage(((task.metadata?.injectionLanguage as 'en' | 'zh-CN' | 'ja-JP' | undefined) ?? i18n.lang.value));
    setDateGranularity(((task.metadata?.dateGranularity as ScheduleDateGranularity | undefined) ?? 'date'));
    setNotes(task.notes ?? '');
    setServeScheduleIcs((task.metadata?.serveScheduleIcs as boolean | undefined) ?? false);
    setIcsLinkMode(task.metadata?.icsLinkMode === 'meeting' ? 'meeting' : 'presenters');
    setIcsContentTemplate(typeof task.metadata?.icsContentTemplate === 'string' ? task.metadata.icsContentTemplate : '');
    const metadataAttachmentTypes = task.metadata?.attachmentTypes;
    if (Array.isArray(metadataAttachmentTypes)) {
      const nextTypes = metadataAttachmentTypes
        .filter((item): item is string => typeof item === 'string')
        .filter((item): item is EmailAttachmentType => item === 'schedule-semester-csv' || item === 'schedule-semester-ics');
      setAttachmentTypes([...new Set(nextTypes)]);
    } else {
      setAttachmentTypes(['schedule-semester-csv', 'schedule-semester-ics']);
    }
    setIsDirty(false);
  }

  function resetForm(nextConfigId?: string): void {
    setSelectedTaskId('');
    setConfigId(nextConfigId ?? configs[0]?.id ?? '');
    setIsDisabled(false);
    setSelectedDays([1, 3, 5]);
    setSendTime('09:00');
    setTaskTimezone(SYSTEM_DEFAULT_TIMEZONE);
    setEmailsText('');
    setRecentTimes(0);
    setSenderNameTemplate('');
    setSubjectTemplate('');
    setTemplateText(DEFAULT_TEMPLATE_PRESETS[0]?.content ?? '');
    setTemplateFormat(DEFAULT_TEMPLATE_PRESETS[0]?.format ?? 'markdown');
    setInjectionLanguage(i18n.lang.value);
    setDateGranularity('date');
    setNotes('');
    setServeScheduleIcs(false);
    setIcsLinkMode('presenters');
    setIcsContentTemplate('');
    setAttachmentTypes(['schedule-semester-csv', 'schedule-semester-ics']);
    setIsDirty(false);
  }

  useEffect(() => {
    if (task) applyTaskToForm(task);
    else resetForm(configs[0]?.id);
    setReady(true);
  }, []);

  const skipNextHashChangeRef = useRef(false);

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    const handleHashChange = (e: HashChangeEvent) => {
      // Skip if this event was triggered by our own programmatic navigation
      if (skipNextHashChangeRef.current) {
        skipNextHashChangeRef.current = false;
        return;
      }
      // Revert the navigation first, then ask for confirmation
      skipNextHashChangeRef.current = true;
      window.history.pushState(null, '', e.oldURL);
      confirmDialog(t('unsavedChangesWarning'), '', () => {
        // User confirmed leaving - navigate to the new URL and mark clean
        setIsDirty(false);
        skipNextHashChangeRef.current = true;
        window.history.pushState(null, '', e.newURL);
      }, undefined, t('confirm'));
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [isDirty]);

  async function saveTask(): Promise<void> {
    if (!configId) return;
    if (taskId && !await db.emailTasks.get(taskId)) {
      toast.error(t('emailTaskNotFound'));
      return;
    }
    const nextId = selectedTaskId || crypto.randomUUID();
    const timezoneSource = taskTimezone === EMAIL_TASK_TIMEZONE_SCHEDULE
      ? 'schedule'
      : taskTimezone === EMAIL_TASK_TIMEZONE_SYSTEM
        ? 'system'
        : taskTimezone === SYSTEM_DEFAULT_TIMEZONE
          ? 'default'
          : 'task';
    const explicitTimezone = timezoneSource === 'task' ? taskTimezone : undefined;
    const task: EmailTask = {
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
    await db.emailTasks.put(task);
    setCurrentTask(task);
    setIsDirty(false);
    setSelectedTaskId(nextId);
    navigate(`/email-tasks/edit/${nextId}`);
  }

  async function removeTask(): Promise<void> {
    if (!selectedTaskId) return;
    await db.emailTasks.delete(selectedTaskId);
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
    await db.emailTasks.put({
      ...current,
      disabled: !current.disabled,
      modifiedAt: Date.now(),
    });
    setCurrentTask(await db.emailTasks.get(selectedTaskId));
    setIsDisabled((prev) => !prev);
  }

  function toggleDay(day: number): void {
    setIsDirty(true);
    setSelectedDays((prev) => prev.includes(day)
      ? prev.filter((value) => value !== day)
      : [...prev, day].sort((a, b) => a - b));
  }

  function insertScheduleTableSnippet(): void {
    setIsDirty(true);
    if (templateFormat === 'html') {
      setTemplateText((prev) => `${prev}\n\n<table border="1" cellpadding="6" cellspacing="0">\n  <thead><tr><th>Date</th><th>Presenter</th><th>Questioners</th></tr></thead>\n  <tbody>\n    <tr><td>{{ now }}</td><td>{{ recipient }}</td><td>{{ summary }}</td></tr>\n  </tbody>\n</table>`.trim());
      return;
    }
    setTemplateText((prev) => `${prev}\n\n| Date | Presenter | Questioners |\n| --- | --- | --- |\n| {{ now }} | {{ recipient }} | {{ summary }} |`.trim());
  }

  function insertIcsLinkSnippet(): void {
    setIsDirty(true);
    const label = t('emailTaskIcsLinkLabel');
    if (templateFormat === 'html') {
      setTemplateText((prev) => `${prev}\n\n<p><a href="{{ scheduleIcsUrl }}">${label}</a></p>`.trim());
      return;
    }
    setTemplateText((prev) => `${prev}\n\n[${label}]({{ scheduleIcsUrl }})`.trim());
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
    t, action, capability, currentTask, ready, selectedTaskId, configId, setConfigId,
    isDisabled, setIsDisabled, selectedDays, sendTime, setSendTime, taskTimezone, setTaskTimezone,
    emailsText, setEmailsText, recentTimes, setRecentTimes, senderNameTemplate, setSenderNameTemplate,
    subjectTemplate, setSubjectTemplate, templateText, setTemplateText, templateFormat, setTemplateFormat,
    injectionLanguage, setInjectionLanguage, dateGranularity, setDateGranularity, notes, setNotes,
    serveScheduleIcs, setServeScheduleIcs, icsLinkMode, setIcsLinkMode, icsContentTemplate, setIcsContentTemplate,
    showPreviewDialog, setShowPreviewDialog, showIcsPreviewDialog, setShowIcsPreviewDialog, icsPreview,
    sendNowOpen, setSendNowOpen, sendRecipientsText, setSendRecipientsText, sendingNow, sendNowError, setSendNowError,
    showDaysDialog, setShowDaysDialog, showVarDialog, setShowVarDialog, varDialogSource,
    showAttachmentDialog, setShowAttachmentDialog, docLanguage, setDocLanguage, setIsDirty,
    attachmentTypes, setAttachmentTypes, configs, resolvedPreviewTimezone, previewResult, previewSubject,
    previewSenderName, attachmentSummary, applyTaskToForm, resetForm, saveTask, removeTask,
    copyNextEmail, copyPublicIcsLink, triggerSendNow, toggleSkipNext, toggleDisabled, toggleDay,
    insertScheduleTableSnippet, insertIcsLinkSnippet, openVariableReference, openIcsPreview,
  };
}
