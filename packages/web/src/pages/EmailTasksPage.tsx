import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
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

const DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const TEMPLATE_VARIABLE_DOCS = [
  {
    name: 'recipient',
    type: 'string',
    descriptions: {
      en: 'Recipient email address.',
      'zh-CN': '收件人邮箱地址。',
      'ja-JP': '受信者メールアドレス。',
    },
  },
  {
    name: 'configId',
    type: 'string',
    descriptions: {
      en: 'Schedule config identifier.',
      'zh-CN': '排班配置 ID。',
      'ja-JP': 'スケジュール設定 ID。',
    },
  },
  {
    name: 'taskId',
    type: 'string',
    descriptions: {
      en: 'Email task identifier (server run).',
      'zh-CN': '邮件任务 ID（服务端执行时）。',
      'ja-JP': 'メールタスク ID（サーバー実行時）。',
    },
  },
  {
    name: 'now',
    type: 'string',
    descriptions: {
      en: 'Current timestamp (ISO).',
      'zh-CN': '当前时间戳（ISO）。',
      'ja-JP': '現在時刻（ISO）。',
    },
  },
  {
    name: 'sessionCount',
    type: 'number',
    descriptions: {
      en: 'Number of sessions in current schedule.',
      'zh-CN': '当前排班中的组会总数。',
      'ja-JP': '現在のスケジュール内の回数。',
    },
  },
  {
    name: 'summary',
    type: 'string',
    descriptions: {
      en: 'Summary sentence for this notification.',
      'zh-CN': '本次通知的摘要文本。',
      'ja-JP': '通知用のサマリ文章。',
    },
  },
  {
    name: 'latestCreatedAt',
    type: 'number|null',
    descriptions: {
      en: 'Latest schedule creation timestamp when available.',
      'zh-CN': '最近一次排班创建时间戳（若存在）。',
      'ja-JP': '最新スケジュール作成時刻（存在する場合）。',
    },
  },
  {
    name: 'language',
    type: 'string',
    descriptions: {
      en: 'Template language code for injected text.',
      'zh-CN': '模板注入文本使用的语言代码。',
      'ja-JP': '注入テキストに使う言語コード。',
    },
  },
] as const;

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
}

function CodeMirrorEditor({ value, onChange }: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

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
            if (update.docChanged) {
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
    view.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} />;
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
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 3, 5]);
  const [emailsText, setEmailsText] = useState('');
  const [recentTimes, setRecentTimes] = useState(0);
  const [templateText, setTemplateText] = useState('');
  const [templateFormat, setTemplateFormat] = useState<TemplateFormat>('markdown');
  const [injectionLanguage, setInjectionLanguage] = useState<'en' | 'zh-CN' | 'ja-JP'>(i18n.lang.value);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [showDaysDialog, setShowDaysDialog] = useState(false);
  const [showVarDialog, setShowVarDialog] = useState(false);
  const [docLanguage, setDocLanguage] = useState<'en' | 'zh-CN' | 'ja-JP'>(i18n.lang.value);

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
    language: injectionLanguage,
  }), [configId, injectionLanguage]);

  const previewResult = useMemo(
    () => renderTemplate(templateText, previewContext, { format: templateFormat }),
    [templateText, previewContext, templateFormat],
  );

  function resetForm(): void {
    setSelectedTaskId('');
    setConfigId(configs[0]?.id ?? '');
    setSelectedDays([1, 3, 5]);
    setEmailsText('');
    setRecentTimes(0);
    setTemplateText(DEFAULT_TEMPLATE_PRESETS[0]?.content ?? '');
    setTemplateFormat(DEFAULT_TEMPLATE_PRESETS[0]?.format ?? 'markdown');
    setInjectionLanguage(i18n.lang.value);
  }

  async function saveTask(): Promise<void> {
    if (!configId) return;
    const nextId = selectedTaskId || nanoid();
    const task: EmailTask = {
      id: nextId,
      configId,
      daysOfWeek: [...selectedDays].sort((a, b) => a - b),
      emails: parseEmails(emailsText),
      recentTimes,
      templateText,
      modifiedAt: Date.now(),
      metadata: {
        format: templateFormat,
        injectionLanguage,
      },
    };
    await db.emailTasks.put(task);
    await loadAllEmailTasks(db);
    setSelectedTaskId(nextId);
  }

  function editTask(task: EmailTask): void {
    setSelectedTaskId(task.id);
    setConfigId(task.configId);
    setSelectedDays(task.daysOfWeek);
    setEmailsText(task.emails.join(', '));
    setRecentTimes(task.recentTimes);
    setTemplateText(task.templateText);
    setTemplateFormat(((task.metadata?.format as TemplateFormat | undefined) ?? 'markdown'));
    setInjectionLanguage(((task.metadata?.injectionLanguage as 'en' | 'zh-CN' | 'ja-JP' | undefined) ?? i18n.lang.value));
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

  function toggleDay(day: number): void {
    setSelectedDays((prev) => prev.includes(day)
      ? prev.filter((value) => value !== day)
      : [...prev, day].sort((a, b) => a - b));
  }

  function insertScheduleTableSnippet(): void {
    if (templateFormat === 'html') {
      setTemplateText((prev) => `${prev}\n\n<table border="1" cellpadding="6" cellspacing="0">\n  <thead><tr><th>Date</th><th>Presenter</th><th>Questioners</th></tr></thead>\n  <tbody>\n    <tr><td>{{ now }}</td><td>{{ recipient }}</td><td>{{ summary }}</td></tr>\n  </tbody>\n</table>`.trim());
      return;
    }
    setTemplateText((prev) => `${prev}\n\n| Date | Presenter | Questioners |\n| --- | --- | --- |\n| {{ now }} | {{ recipient }} | {{ summary }} |`.trim());
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
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowDaysDialog(true)}>{t('selectWeekdays')}</Button>
            <span class={`${s.text12} ${s.textMuted}`}>
              {selectedDays.map((day) => DAY_OPTIONS.find((item) => item.value === day)?.label ?? String(day)).join(', ') || t('noneSelected')}
            </span>
          </div>
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
          <label class={s.label}>{t('templateInjectionLanguage')}</label>
          <select class={s.input} value={injectionLanguage} onChange={(e) => setInjectionLanguage((e.target as HTMLSelectElement).value as 'en' | 'zh-CN' | 'ja-JP')}>
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
            <option value="ja-JP">日本語</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplateEditor')}</label>
          <CodeMirrorEditor value={templateText} onChange={setTemplateText} />
          <div class={`${s.text12} ${s.textMuted}`}>{t('templateSyntaxHint')}</div>
          <div class={s.flexGapSm}>
            <Button variant="ghost" onClick={insertScheduleTableSnippet}>{t('insertScheduleTableTemplate')}</Button>
            <Button variant="ghost" onClick={() => { setDocLanguage(i18n.lang.value); setShowVarDialog(true); }}>
              {t('templateVariableReference')}
            </Button>
          </div>
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
              {TEMPLATE_VARIABLE_DOCS.map((item) => (
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
    </div>
  );
}
