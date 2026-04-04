import { useEffect, useMemo, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import {
  DEFAULT_TEMPLATE_PRESETS,
  renderTemplate,
  type EmailTask,
  type TemplateFormat,
} from '@labby/core';
import { Button, Dialog } from '../components/ui';
import { useDatabase, loadAllConfigs, loadAllEmailTasks } from '../db';
import { configsSignal, emailTasksSignal } from '../store';
import { i18n } from '@/i18n';
import * as s from '../styles/components.css';
import { getEmailTaskCapability } from '@/lib/email-task-capability';

function parseDays(input: string): number[] {
  return input
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((day) => Number.isFinite(day) && day >= 0 && day <= 6);
}

function parseEmails(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function EmailTasksPage() {
  const { t } = i18n;
  const db = useDatabase();
  const configs = configsSignal.value;
  const tasks = emailTasksSignal.value;
  const capability = getEmailTaskCapability();

  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [configId, setConfigId] = useState('');
  const [daysText, setDaysText] = useState('1,3,5');
  const [emailsText, setEmailsText] = useState('');
  const [recentTimes, setRecentTimes] = useState(0);
  const [templateText, setTemplateText] = useState('');
  const [templateFormat, setTemplateFormat] = useState<TemplateFormat>('markdown');
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await Promise.all([loadAllConfigs(db), loadAllEmailTasks(db)]);
      if (cancelled) return;
      if (!configId && configsSignal.value[0]) {
        setConfigId(configsSignal.value[0].id);
      }
      if (!templateText && DEFAULT_TEMPLATE_PRESETS[0]) {
        setTemplateText(DEFAULT_TEMPLATE_PRESETS[0].content);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const previewContext = useMemo(() => ({
    recipient: 'preview@example.com',
    configId: configId || 'config-preview',
    now: new Date().toISOString(),
    sessionCount: 4,
    summary: 'This is a local preview. In frontend-only mode, emails are not auto-sent.',
  }), [configId]);

  const previewResult = useMemo(
    () => renderTemplate(templateText, previewContext, { format: templateFormat }),
    [templateText, previewContext, templateFormat],
  );

  function resetForm(): void {
    setSelectedTaskId('');
    setConfigId(configs[0]?.id ?? '');
    setDaysText('1,3,5');
    setEmailsText('');
    setRecentTimes(0);
    setTemplateText(DEFAULT_TEMPLATE_PRESETS[0]?.content ?? '');
    setTemplateFormat(DEFAULT_TEMPLATE_PRESETS[0]?.format ?? 'markdown');
  }

  async function saveTask(): Promise<void> {
    if (!configId) return;
    const nextId = selectedTaskId || nanoid();
    const task: EmailTask = {
      id: nextId,
      configId,
      daysOfWeek: parseDays(daysText),
      emails: parseEmails(emailsText),
      recentTimes,
      templateText,
      metadata: {
        format: templateFormat,
      },
    };
    await db.emailTasks.put(task);
    await loadAllEmailTasks(db);
    setSelectedTaskId(nextId);
  }

  function editTask(task: EmailTask): void {
    setSelectedTaskId(task.id);
    setConfigId(task.configId);
    setDaysText(task.daysOfWeek.join(','));
    setEmailsText(task.emails.join(', '));
    setRecentTimes(task.recentTimes);
    setTemplateText(task.templateText);
    setTemplateFormat(((task.metadata?.format as TemplateFormat | undefined) ?? 'markdown'));
  }

  async function removeTask(id: string): Promise<void> {
    await db.emailTasks.delete(id);
    await loadAllEmailTasks(db);
    if (selectedTaskId === id) resetForm();
  }

  async function copyNextEmail(): Promise<void> {
    const rendered = renderTemplate(templateText, previewContext, { format: templateFormat });
    await navigator.clipboard.writeText(rendered.output);
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navEmailTasks')}</h2>
      </div>

      {!capability.canAutoSend && (
        <div class={`${s.card} ${s.mb16}`}>
          <strong>{t('emailFrontendOnlyWarningTitle')}</strong>
          <p class={`${s.text14} ${s.textMuted}`}>{t('emailFrontendOnlyWarningBody')}</p>
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowPreviewDialog(true)}>
              {t('openNextEmailPreview')}
            </Button>
            <Button variant="secondary" onClick={() => void copyNextEmail()}>
              {t('copyNextEmailManually')}
            </Button>
          </div>
        </div>
      )}

      <div class={`${s.card} ${s.mb16}`}>
        <strong class={s.sectionTitle}>{t('emailTaskEditorTitle')}</strong>
        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskConfig')}</label>
          <select class={s.input} value={configId} onChange={(e) => setConfigId((e.target as HTMLSelectElement).value)}>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>{config.id}</option>
            ))}
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskDays')}</label>
          <input class={s.input} value={daysText} onInput={(e) => setDaysText((e.target as HTMLInputElement).value)} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskEmails')}</label>
          <input class={s.input} value={emailsText} onInput={(e) => setEmailsText((e.target as HTMLInputElement).value)} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskRecentTimes')}</label>
          <input
            class={s.input}
            type="number"
            min={0}
            value={recentTimes}
            onInput={(e) => setRecentTimes(Number.parseInt((e.target as HTMLInputElement).value || '0', 10))}
          />
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
          <select class={s.input} value={templateFormat} onChange={(e) => setTemplateFormat((e.target as HTMLSelectElement).value as TemplateFormat)}>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplateEditor')}</label>
          <textarea class={s.input} rows={10} value={templateText} onInput={(e) => setTemplateText((e.target as HTMLTextAreaElement).value)} />
          <div class={`${s.text12} ${s.textMuted}`}>{t('templateSyntaxHint')}</div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplatePreview')}</label>
          <div class={s.card}>
            {templateFormat === 'html'
              ? <div dangerouslySetInnerHTML={{ __html: previewResult.output }} />
              : <pre class={s.preWrap}>{previewResult.output}</pre>}
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
          <Button variant="primary" onClick={() => void saveTask()}>{t('save')}</Button>
          <Button variant="secondary" onClick={resetForm}>{t('cancel')}</Button>
        </div>
      </div>

      <div class={s.card}>
        <strong>{t('emailTaskList')}</strong>
        <div class={s.mt8}>
          {tasks.length === 0 && <p class={`${s.text14} ${s.textMuted}`}>{t('noEmailTasksYet')}</p>}
          {tasks.map((task) => (
            <div key={task.id} class={s.historyItem}>
              <button class={s.badgeButton} onClick={() => editTask(task)}>
                {task.id} · {task.configId} · {task.emails.length} emails
              </button>
              <div class={s.flexGapXs}>
                <Button variant="ghost" onClick={() => editTask(task)}>{t('edit')}</Button>
                <Button variant="danger" onClick={() => void removeTask(task.id)}>{t('delete')}</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showPreviewDialog && (
        <Dialog open={true} onClose={() => setShowPreviewDialog(false)} title={t('openNextEmailPreview')}>
          <div class={s.formGroup}>
            <pre class={s.preWrap}>{previewResult.output}</pre>
            <div class={s.flexGapSm}>
              <Button variant="secondary" onClick={() => void copyNextEmail()}>{t('copyNextEmailManually')}</Button>
              <Button variant="ghost" onClick={() => setShowPreviewDialog(false)}>{t('close')}</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
