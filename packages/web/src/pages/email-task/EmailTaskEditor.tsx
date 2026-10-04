import {
  DEFAULT_TEMPLATE_PRESETS,
  EMAIL_TASK_TIMEZONE_SCHEDULE,
  EMAIL_TASK_TIMEZONE_SYSTEM,
  type ScheduleDateGranularity,
  type TemplateFormat,
} from '@labby/core';
import { Button, ContentSkeleton } from '@/components/ui';
import { NumericInput } from '@/components/ui/NumericInput';
import { confirmDialog } from '@/components/ui/Dialog';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { navigate } from '@/lib/router';
import { getScheduleConfigLabel } from '@/lib/scheduleConfigLabel';
import * as s from '@/styles/components.css';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { EmailPreviewContent, TemplateErrors } from './TemplatePreview';
import { EmailTaskDialogs } from './EmailTaskDialogs';
import { EmailTaskIcsSettings } from './EmailTaskIcsSettings';
import { DAY_OPTIONS, useEmailTaskEditor, type EmailTaskEditorProps } from './useEmailTaskEditor';

export function EmailTaskEditor(props: EmailTaskEditorProps) {
  const editor = useEmailTaskEditor(props);
  const {
    t, action, capability, currentTask, ready, selectedTaskId, form, values,
    setShowPreviewDialog, setSendNowOpen, setSendRecipientsText, setSendNowError,
    setShowDaysDialog, setShowAttachmentDialog,
    configs, resolvedPreviewTimezone, previewResult, previewSubject,
    previewSenderName, attachmentSummary, applyTaskToForm, resetForm, saveTask, removeTask,
    copyNextEmail, toggleSkipNext, toggleDisabled,
    insertScheduleTableSnippet, insertIcsLinkSnippet, openVariableReference,
  } = editor;
  const {
    configId, isDisabled, selectedDays, sendTime, taskTimezone, emailsText, recentTimes,
    senderNameTemplate, subjectTemplate, templateText, templateFormat, injectionLanguage,
    dateGranularity, notes,
  } = values;

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
          <select class={s.input} value={configId} onChange={(e) => { form.setFieldValue('configId', (e.target as HTMLSelectElement).value); }}>
            <option value="">{t('selectConfigFirst')}</option>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>{getScheduleConfigLabel(config)}</option>
            ))}
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.checkboxRow}>
            <input
              class={s.checkboxRowInput}
              type="checkbox"
              checked={!isDisabled}
              onChange={(e) => { form.setFieldValue('isDisabled', !(e.target as HTMLInputElement).checked); }}
            />
            <span class={s.label}>{t('emailTaskEnabled')}</span>
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
            onInput={(e) => { form.setFieldValue('sendTime', (e.target as HTMLInputElement).value || '09:00'); }}
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
            onChange={(value) => { form.setFieldValue('taskTimezone', value); }}
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('resolvedTimezone')}: {resolvedPreviewTimezone}</div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskEmails')}</label>
          <input class={s.input} value={emailsText} onInput={(e) => { form.setFieldValue('emailsText', (e.target as HTMLInputElement).value); }} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('senderNameTemplate')}</label>
          <input
            class={s.input}
            value={senderNameTemplate}
            onInput={(e) => { form.setFieldValue('senderNameTemplate', (e.target as HTMLInputElement).value); }}
            placeholder="{{ configId }}"
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('senderNamePreview')}: {previewSenderName.output || '—'}</div>
          <TemplateErrors errors={previewSenderName.errors} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskRecentTimes')}</label>
          <NumericInput
            class={s.input}
            min={0}
            value={recentTimes}
            onValueInput={(raw) => { form.setFieldValue('recentTimes', Number.parseInt(raw, 10)); }}
          />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTaskSubjectTemplate')}</label>
          <input
            class={s.input}
            value={subjectTemplate}
            onInput={(e) => { form.setFieldValue('subjectTemplate', (e.target as HTMLInputElement).value); }}
            placeholder={t('emailTaskDefaultSubject')}
          />
          <div class={`${s.text12} ${s.textMuted}`}>{t('emailTaskSubjectTemplateHint')}</div>
          <div class={`${s.text12} ${s.textMuted}`}>{t('emailSubjectPreview')}: {previewSubject.output}</div>
          <TemplateErrors errors={previewSubject.errors} />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplatePreset')}</label>
          <select
            class={s.input}
            onChange={(e) => {
              const preset = DEFAULT_TEMPLATE_PRESETS.find((item) => item.id === (e.target as HTMLSelectElement).value);
              if (!preset) return;
              form.setFieldValue('templateText', preset.content);
              form.setFieldValue('templateFormat', preset.format);
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
          <select class={s.input} value={templateFormat} onChange={(e) => { form.setFieldValue('templateFormat', (e.target as HTMLSelectElement).value as TemplateFormat); }}>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('templateInjectionLanguage')}</label>
          <select class={s.input} value={injectionLanguage} onChange={(e) => { form.setFieldValue('injectionLanguage', (e.target as HTMLSelectElement).value as 'en' | 'zh-CN' | 'ja-JP'); }}>
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
            <option value="ja-JP">日本語</option>
          </select>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('dateDisplayGranularity')}</label>
          <select class={s.input} value={dateGranularity} onChange={(e) => { form.setFieldValue('dateGranularity', (e.target as HTMLSelectElement).value as ScheduleDateGranularity); }}>
            <option value="date">{t('dateGranularityDate')}</option>
            <option value="date-time">{t('dateGranularityDateTime')}</option>
            <option value="month-day">{t('dateGranularityMonthDay')}</option>
            <option value="month-day-time">{t('dateGranularityMonthDayTime')}</option>
          </select>
        </div>

        <EmailTaskIcsSettings editor={editor} />

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
            onInput={(e) => { form.setFieldValue('notes', (e.target as HTMLTextAreaElement).value); }}
          />
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplateEditor')}</label>
          <CodeMirrorEditor value={templateText} onChange={(v) => { form.setFieldValue('templateText', v); }} />
          <div class={`${s.text12} ${s.textMuted}`}>{t('templateSyntaxHint')}</div>
          <div class={s.flexGapSm}>
            <Button variant="ghost" onClick={insertScheduleTableSnippet}>{t('insertScheduleTableTemplate')}</Button>
            <Button variant="ghost" onClick={insertIcsLinkSnippet}>{t('emailTaskInsertIcsLink')}</Button>
            <Button variant="ghost" onClick={() => openVariableReference('email')}>
              {t('templateVariableReference')}
            </Button>
          </div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('emailTemplatePreview')}</label>
          <EmailPreviewContent html={previewResult.html} />
          <TemplateErrors errors={previewResult.errors} />
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

      <EmailTaskDialogs editor={editor} />
    </div>
  );
}
