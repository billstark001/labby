import { EMAIL_TEMPLATE_VARIABLE_DOCS, ICS_TEMPLATE_VARIABLE_DOCS } from '@labby/core';
import { Button, Dialog } from '@/components/ui';
import * as s from '@/styles/components.css';
import { AttachmentSettingsDialog } from './AttachmentSettingsDialog';
import { EmailPreviewContent } from './TemplatePreview';
import { DAY_OPTIONS, type useEmailTaskEditor } from './useEmailTaskEditor';

type EmailTaskDialogProps = { editor: ReturnType<typeof useEmailTaskEditor> };

export function EmailTaskDialogs({ editor }: EmailTaskDialogProps) {
  const {
    t, action, sendNowOpen, setSendNowOpen, sendingNow, triggerSendNow, sendRecipientsText,
    setSendRecipientsText, sendNowError, showPreviewDialog, setShowPreviewDialog, previewResult,
    copyNextEmail, showIcsPreviewDialog, setShowIcsPreviewDialog, icsPreview, showDaysDialog,
    setShowDaysDialog, toggleDay, showVarDialog, setShowVarDialog,
    docLanguage, setDocLanguage, varDialogSource, showAttachmentDialog, setShowAttachmentDialog,
    form, values,
  } = editor;
  const { selectedDays, attachmentTypes } = values;

  return <>
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
            <EmailPreviewContent html={previewResult.html} />
            <div class={s.flexGapSm}>
              <Button variant="secondary" busy={action.pendingKey === 'copy'} onClick={() => void action.run('copy', copyNextEmail)}>{t('copyNextEmailManually')}</Button>
              <Button variant="ghost" onClick={() => setShowPreviewDialog(false)}>{t('close')}</Button>
            </div>
          </div>
        </Dialog>
      )}

      {showIcsPreviewDialog && (
        <Dialog open={true} onClose={() => setShowIcsPreviewDialog(false)} title={t('emailTaskIcsPreview')}>
          {icsPreview.error
            ? <p role="alert" class={s.textDanger}>{icsPreview.error}</p>
            : <div class={s.card}><pre class={s.preWrap}>{icsPreview.text}</pre></div>}
          <div class={s.flexGapSm}>
            <Button variant="secondary" onClick={() => setShowIcsPreviewDialog(false)}>{t('close')}</Button>
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
              {(varDialogSource === 'ics'
                ? [
                  ...ICS_TEMPLATE_VARIABLE_DOCS,
                  ...EMAIL_TEMPLATE_VARIABLE_DOCS.filter((item) => item.name === 'taskId' || item.name === 'configId' || item.name === 'scheduleIcsUrl' || item.name.startsWith('schedule') || item.name === 'nextSession' || item.name.startsWith('nextSession.')),
                ]
                : EMAIL_TEMPLATE_VARIABLE_DOCS).map((item) => (
                <tr key={item.name}>
                  <td class={s.td}><code title={item.name} style={{ paddingInlineStart: `${Math.max(0, item.name.split('.').length - 1) * 16}px` }}>
                    {item.name.includes('.') ? `↳ ${item.name.split('.').at(-1)}` : item.name}
                  </code></td>
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
            form.setFieldValue('attachmentTypes', next);
          }}
        />
      )}
  </>;
}
