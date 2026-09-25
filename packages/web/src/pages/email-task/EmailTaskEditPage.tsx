import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  DEFAULT_TEMPLATE_PRESETS,
  EMAIL_TASK_TIMEZONE_SCHEDULE,
  EMAIL_TASK_TIMEZONE_SYSTEM,
  EMAIL_TEMPLATE_VARIABLE_DOCS,
  SYSTEM_DEFAULT_TIMEZONE,
  buildEmailTemplateScheduleVariables,
  getEnvironmentTimeZone,
  normalizeTimeZone,
  renderTemplate,
  renderTemplateToHtml,
  type EmailTask,
  type Person,
  type ScheduleConfig,
  type SchedulePlan,
  type ScheduleDateGranularity,
  type TemplateFormat,
} from '@labby/core';

import { Button, ContentSkeleton, Dialog, toast } from '@/components/ui';
import { NumericInput } from '@/components/ui/NumericInput';
import { confirmDialog } from '@/components/ui/Dialog';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { readAllPaginated, useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { sendEmailTaskNow, setEmailTaskSkipNext } from '@/api-server/email-tasks';
import { getEmailTaskCapability } from '@/lib/email-task-capability';
import { getPublicEmailTaskIcsUrl } from '@/lib/email-task-ics';
import { navigate } from '@/lib/router';
import { getScheduleConfigLabel } from '@/lib/scheduleConfigLabel';
import { useAsyncResource } from '@/lib/use-async-resource';
import { usePendingAction } from '@/lib/use-pending-action';
import * as s from '@/styles/components.css';
import { AttachmentSettingsDialog, type EmailAttachmentType } from './AttachmentSettingsDialog';

const DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
}

function CodeMirrorEditor({ value, onChange }: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const externalUpdate = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.theme({
            '&': {
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              minHeight: '260px',
              fontSize: '13px',
            },
            '.cm-content': {
              minHeight: '240px',
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalUpdate.current) {
              onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === value) return;
    externalUpdate.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: currentDoc.length, insert: value } });
    } finally {
      externalUpdate.current = false;
    }
  }, [value]);

  return <div ref={hostRef} />;
}

function parseEmails(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

interface EmailTaskEditPageProps {
  taskId?: string;
}

export function EmailTaskEditPage({ taskId }: EmailTaskEditPageProps) {
  const db = useDatabase();
  const { t } = i18n;
  const query = useAsyncResource(async () => {
    const [task, configs, persons, schedules, settings] = await Promise.all([
      taskId ? db.emailTasks.get(taskId) : Promise.resolve(undefined),
      readAllPaginated(db.configs),
      readAllPaginated(db.persons),
      readAllPaginated(db.schedules),
      db.systemSettings.get(),
    ]);
    return { task, configs, persons, schedules, systemTimezone: settings.timezone };
  }, [db, taskId]);

  if (query.isInitialLoading) return <ContentSkeleton rows={8} />;
  if (query.error || !query.data) return <div role="alert" class={s.card}>
    <p class={s.textDanger}>{String(query.error)}</p>
    <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button>
  </div>;
  if (taskId && !query.data.task) return <div class={s.card}>
    <p class={s.textDanger}>{t('emailTaskNotFound')}</p>
    <Button variant="secondary" onClick={() => navigate('/email-tasks')}>{t('backToList')}</Button>
  </div>;

  return <EmailTaskEditor key={taskId ?? '__new__'} taskId={taskId} {...query.data} />;
}

type EmailTaskEditorProps = EmailTaskEditPageProps & {
  task: EmailTask | undefined;
  configs: ScheduleConfig[];
  persons: Person[];
  schedules: SchedulePlan[];
  systemTimezone: string | undefined;
};

function EmailTaskEditor({ taskId, task, configs, persons, schedules, systemTimezone: initialSystemTimezone }: EmailTaskEditorProps) {
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
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [sendNowOpen, setSendNowOpen] = useState(false);
  const [sendRecipientsText, setSendRecipientsText] = useState('');
  const [sendingNow, setSendingNow] = useState(false);
  const [sendNowError, setSendNowError] = useState('');
  const [showDaysDialog, setShowDaysDialog] = useState(false);
  const [showVarDialog, setShowVarDialog] = useState(false);
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

  const previewContext = useMemo(() => ({
    recipient: 'preview@example.com',
    configId: configId || 'config-preview',
    taskId: selectedTaskId || 'task-preview',
    now: new Intl.DateTimeFormat(injectionLanguage, {
      timeZone: resolvedPreviewTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(new Date()),
    nowIsoUtc: new Date().toISOString(),
    nowLocal: new Intl.DateTimeFormat(injectionLanguage, {
      timeZone: resolvedPreviewTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(new Date()),
    runTimezone: resolvedPreviewTimezone,
    sessionCount: 4,
    summary: 'This is a local preview. In frontend-only mode, emails are not auto-sent.',
    language: injectionLanguage,
    scheduleIcsUrl: serveScheduleIcs && selectedTaskId ? getPublicEmailTaskIcsUrl(selectedTaskId) : undefined,
    ...injectedScheduleVariables,
  }), [configId, selectedTaskId, injectionLanguage, resolvedPreviewTimezone, serveScheduleIcs, injectedScheduleVariables]);

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

  if (!ready) return <ContentSkeleton rows={8} />;

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('emailTaskEditorTitle')}</h2>
        <div class={s.flexGapSm}>
          {selectedTaskId && (
            <Button variant="ghost" busy={action.pendingKey === 'disable'} disabled={action.pendingKey !== null} onClick={() => void action.run('disable', toggleDisabled)}>
              {currentTask?.disabled ? t('enable') : t('disable')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate('/email-tasks')}>{t('backToList')}</Button>
          {selectedTaskId && <Button variant="danger" disabled={action.pendingKey !== null} onClick={() => confirmDialog(t('confirmDelete'), t('deleteHistory'), removeTask)}>{t('delete')}</Button>}
        </div>
      </div>

      {!capability.canAutoSend && (
        <div class={`${s.card} ${s.mb16}`}>
          <strong>{t('emailFrontendOnlyWarningTitle')}</strong>
          <p class={`${s.text14} ${s.textMuted}`}>{t('emailFrontendOnlyWarningBody')}</p>
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowPreviewDialog(true)}>
              {t('openNextEmailPreview')}
            </Button>
            <Button variant="secondary" busy={action.pendingKey === 'copy'} onClick={() => void action.run('copy', copyNextEmail)}>
              {t('copyNextEmailManually')}
            </Button>
          </div>
        </div>
      )}

      <div class={s.card}>
        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskConfig')}</label>
          <select class={s.input} value={configId} onChange={(e) => { setIsDirty(true); setConfigId((e.target as HTMLSelectElement).value); }}>
            <option value="">{t('selectConfigFirst')}</option>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>{getScheduleConfigLabel(config)}</option>
            ))}
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('disabled')}</label>
          <label class={s.flexGapSm}>
            <input
              type="checkbox"
              checked={isDisabled}
              onChange={(e) => { setIsDirty(true); setIsDisabled((e.target as HTMLInputElement).checked); }}
            />
            <span class={`${s.text12} ${s.textMuted}`}>{isDisabled ? t('disabled') : t('enable')}</span>
          </label>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskDays')}</label>
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowDaysDialog(true)}>{t('selectWeekdays')}</Button>
            <span class={`${s.text12} ${s.textMuted}`}>
              {selectedDays.map((day) => DAY_OPTIONS.find((item) => item.value === day)?.label ?? String(day)).join(', ') || t('noneSelected')}
            </span>
          </div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskSendTime')}</label>
          <input
            class={s.input}
            type="time"
            value={sendTime}
            onInput={(e) => { setIsDirty(true); setSendTime((e.target as HTMLInputElement).value || '09:00'); }}
          />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskTimezone')}</label>
          <TimezoneSelect
            value={taskTimezone}
            defaultLabel={t('emailTaskTimezoneDefault')}
            specialOptions={[
              { value: EMAIL_TASK_TIMEZONE_SCHEDULE, label: t('emailTaskTimezoneSchedule') },
              { value: EMAIL_TASK_TIMEZONE_SYSTEM, label: t('emailTaskTimezoneSystem') },
            ]}
            onChange={(value) => { setIsDirty(true); setTaskTimezone(value); }}
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('resolvedTimezone')}: {resolvedPreviewTimezone}</div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskEmails')}</label>
          <input class={s.input} value={emailsText} onInput={(e) => { setIsDirty(true); setEmailsText((e.target as HTMLInputElement).value); }} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('senderNameTemplate')}</label>
          <input
            class={s.input}
            value={senderNameTemplate}
            onInput={(e) => { setIsDirty(true); setSenderNameTemplate((e.target as HTMLInputElement).value); }}
            placeholder="{{ configId }}"
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('senderNamePreview')}: {previewSenderName.output || '—'}</div>
          {previewSenderName.errors.length > 0 && (
            <div class={s.textDanger}>
              {previewSenderName.errors.map((err) => (
                <div key={`${err.start}-${err.end}-${err.message}`}>{err.kind}: {err.message}</div>
              ))}
            </div>
          )}
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskRecentTimes')}</label>
          <NumericInput
            class={s.input}
            min={0}
            value={recentTimes}
            onValueInput={(raw) => { setIsDirty(true); setRecentTimes(Number.parseInt(raw, 10)); }}
          />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskSubjectTemplate')}</label>
          <input
            class={s.input}
            value={subjectTemplate}
            onInput={(e) => { setIsDirty(true); setSubjectTemplate((e.target as HTMLInputElement).value); }}
            placeholder={t('emailTaskDefaultSubject')}
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('emailTaskSubjectTemplateHint')}</div>
          <div class={`${s.text12} ${s.textMuted}`}>{t('emailSubjectPreview')}: {previewSubject.output}</div>
          {previewSubject.errors.length > 0 && (
            <div class={s.textDanger}>
              {previewSubject.errors.map((err) => (
                <div key={`${err.start}-${err.end}-${err.message}`}>{err.kind}: {err.message}</div>
              ))}
            </div>
          )}
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplatePreset')}</label>
          <select
            class={s.input}
            onChange={(e) => {
              const preset = DEFAULT_TEMPLATE_PRESETS.find((item) => item.id === (e.target as HTMLSelectElement).value);
              if (!preset) return;
              setTemplateText(preset.content);
              setTemplateFormat(preset.format);
            }}
          >
            <option value="">{t('select')}</option>
            {DEFAULT_TEMPLATE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplateFormat')}</label>
          <select class={s.input} value={templateFormat} onChange={(e) => { setIsDirty(true); setTemplateFormat((e.target as HTMLSelectElement).value as TemplateFormat); }}>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('templateInjectionLanguage')}</label>
          <select class={s.input} value={injectionLanguage} onChange={(e) => { setIsDirty(true); setInjectionLanguage((e.target as HTMLSelectElement).value as 'en' | 'zh-CN' | 'ja-JP'); }}>
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
            <option value="ja-JP">日本語</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('dateDisplayGranularity')}</label>
          <select class={s.input} value={dateGranularity} onChange={(e) => { setIsDirty(true); setDateGranularity((e.target as HTMLSelectElement).value as ScheduleDateGranularity); }}>
            <option value="date">{t('dateGranularityDate')}</option>
            <option value="date-time">{t('dateGranularityDateTime')}</option>
            <option value="month-day">{t('dateGranularityMonthDay')}</option>
            <option value="month-day-time">{t('dateGranularityMonthDayTime')}</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskServeScheduleIcs')}</label>
          <label class={s.flexGapSm}>
            <input
              type="checkbox"
              checked={serveScheduleIcs}
              onChange={(e) => { setIsDirty(true); setServeScheduleIcs((e.target as HTMLInputElement).checked); }}
            />
            <span class={`${s.text12} ${s.textMuted}`}>{t('emailTaskServeScheduleIcsHint')}</span>
          </label>
          <div class={s.flexGapSm}>
            <Button variant="secondary" busy={action.pendingKey === 'copy-ics'} disabled={!selectedTaskId || !serveScheduleIcs || !capability.canAutoSend} onClick={() => void action.run('copy-ics', copyPublicIcsLink)}>
              {t('emailTaskCopyIcsLink')}
            </Button>
            <Button variant="ghost" onClick={insertIcsLinkSnippet}>
              {t('emailTaskInsertIcsLink')}
            </Button>
          </div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskAttachments')}</label>
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowAttachmentDialog(true)}>{t('emailTaskAttachmentDialogOpen')}</Button>
            <span class={`${s.text12} ${s.textMuted}`}>{attachmentSummary}</span>
          </div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('notes')}</label>
          <textarea
            class={s.input}
            rows={3}
            value={notes}
            onInput={(e) => { setIsDirty(true); setNotes((e.target as HTMLTextAreaElement).value); }}
          />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplateEditor')}</label>
          <CodeMirrorEditor value={templateText} onChange={(v) => { setIsDirty(true); setTemplateText(v); }} />
          <div class={`${s.text12} ${s.textMuted}`}>{t('templateSyntaxHint')}</div>
          <div class={s.flexGapSm}>
            <Button variant="ghost" onClick={insertScheduleTableSnippet}>{t('insertScheduleTableTemplate')}</Button>
            <Button variant="ghost" onClick={insertIcsLinkSnippet}>{t('emailTaskInsertIcsLink')}</Button>
            <Button variant="ghost" onClick={() => { setDocLanguage(i18n.lang.value); setShowVarDialog(true); }}>
              {t('templateVariableReference')}
            </Button>
          </div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplatePreview')}</label>
          <div class={s.card}>
            <div dangerouslySetInnerHTML={{ __html: previewResult.html }} />
          </div>
          {previewResult.errors.length > 0 && (
            <div class={s.textDanger}>
              {previewResult.errors.map((err) => (
                <div key={`${err.start}-${err.end}-${err.message}`}>{err.kind}: {err.message}</div>
              ))}
            </div>
          )}
        </div>

        <div class={s.flexGapSm}>
          <Button variant="primary" busy={action.pendingKey === 'save'} disabled={action.pendingKey !== null} onClick={() => void action.run('save', saveTask)}>{t('save')}</Button>
          <Button variant="secondary" onClick={() => currentTask ? applyTaskToForm(currentTask) : resetForm(configId || configs[0]?.id)}>{t('cancel')}</Button>
          {capability.canAutoSend && selectedTaskId && (
            <>
              <Button variant="secondary" onClick={() => {
                setSendRecipientsText((currentTask?.emails ?? []).join(', '));
                setSendNowError('');
                setSendNowOpen(true);
              }}>{t('emailTaskSendNow')}</Button>
              <Button variant="ghost" busy={action.pendingKey === 'skip'} disabled={action.pendingKey !== null} onClick={() => void action.run('skip', toggleSkipNext)}>
                {currentTask?.skipNextRun ? t('emailTaskSkipNextCancel') : t('emailTaskSkipNext')}
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => navigate('/email-tasks')}>{t('backToList')}</Button>
        </div>
      </div>

      {sendNowOpen && <Dialog
        open
        onClose={() => { if (!sendingNow) setSendNowOpen(false); }}
        closeOnOverlayClick={!sendingNow}
        title={t('emailTaskSendNow')}
        width="min(520px, 92vw)"
        actions={<>
          <Button busy={sendingNow} onClick={() => void triggerSendNow()}>
            {sendingNow ? t('emailTaskSending') : t('emailTaskSendNow')}
          </Button>
          <Button variant="secondary" disabled={sendingNow} onClick={() => setSendNowOpen(false)}>{t('cancel')}</Button>
        </>}
      >
        <p class={s.mutedParagraph}>{t('emailTaskOneOffRecipientsHint')}</p>
        <div class={s.formGroup}>
          <label class={s.label} for="send-now-recipients">{t('emailTaskEmails')}</label>
          <textarea id="send-now-recipients" class={`${s.input} ${s.fullWidthTextarea}`} rows={3} value={sendRecipientsText}
            disabled={sendingNow} onInput={event => setSendRecipientsText((event.target as HTMLTextAreaElement).value)} />
          <small class={s.textMuted}>{t('emailTaskRecipientSeparatorHint')}</small>
        </div>
        {sendNowError && <p role="alert" class={s.textDanger}>{sendNowError}</p>}
      </Dialog>}

      {showPreviewDialog && (
        <Dialog open={true} onClose={() => setShowPreviewDialog(false)} title={t('openNextEmailPreview')}>
          <div class={s.formGroup}>
            <div class={s.card}>
              <div dangerouslySetInnerHTML={{ __html: previewResult.html }} />
            </div>
            <div class={s.flexGapSm}>
              <Button variant="secondary" busy={action.pendingKey === 'copy'} onClick={() => void action.run('copy', copyNextEmail)}>{t('copyNextEmailManually')}</Button>
              <Button variant="ghost" onClick={() => setShowPreviewDialog(false)}>{t('close')}</Button>
            </div>
          </div>
        </Dialog>
      )}

      {showDaysDialog && (
        <Dialog open={true} onClose={() => setShowDaysDialog(false)} title={t('selectWeekdays')}>
          <div class={s.formGroup}>
            <div class={s.tagList}>
              {DAY_OPTIONS.map((day) => (
                <button
                  key={day.value}
                  class={`${s.badgeSelectable} ${selectedDays.includes(day.value) ? s.badgeSelectableActive : ''}`}
                  onClick={() => toggleDay(day.value)}
                >
                  {day.label}
                </button>
              ))}
            </div>
          </div>
          <div class={s.flexGapSm}>
            <Button variant="primary" onClick={() => setShowDaysDialog(false)}>{t('confirm')}</Button>
            <Button variant="secondary" onClick={() => setShowDaysDialog(false)}>{t('cancel')}</Button>
          </div>
        </Dialog>
      )}

      {showVarDialog && (
        <Dialog open={true} onClose={() => setShowVarDialog(false)} title={t('templateVariableReference')}>
          <div class={s.formGroup}>
            <label class={s.label}>{t('languageLabel')}</label>
            <select class={s.input} value={docLanguage} onChange={(e) => setDocLanguage((e.target as HTMLSelectElement).value as 'en' | 'zh-CN' | 'ja-JP')}>
              <option value="en">English</option>
              <option value="zh-CN">中文</option>
              <option value="ja-JP">日本語</option>
            </select>
          </div>
          <table class={s.table}>
            <thead>
              <tr>
                <th class={s.th}>{t('templateVariableName')}</th>
                <th class={s.th}>{t('templateVariableType')}</th>
                <th class={s.th}>{t('templateVariableDescription')}</th>
              </tr>
            </thead>
            <tbody>
              {EMAIL_TEMPLATE_VARIABLE_DOCS.map((item) => (
                <tr key={item.name}>
                  <td class={s.td}>{item.name}</td>
                  <td class={s.td}>{item.type}</td>
                  <td class={s.td}>{item.descriptions[docLanguage]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowVarDialog(false)}>{t('close')}</Button>
          </div>
        </Dialog>
      )}

      {showAttachmentDialog && (
        <AttachmentSettingsDialog
          open={showAttachmentDialog}
          onClose={() => setShowAttachmentDialog(false)}
          selected={attachmentTypes}
          onChange={(next) => {
            setIsDirty(true);
            setAttachmentTypes(next);
          }}
        />
      )}
    </div>
  );
}
