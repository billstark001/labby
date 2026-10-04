import type { ScheduleIcsMode } from '@labby/core';
import { Button } from '@/components/ui';
import * as s from '@/styles/components.css';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import type { useEmailTaskEditor } from './useEmailTaskEditor';

type EmailTaskIcsSettingsProps = { editor: ReturnType<typeof useEmailTaskEditor> };

export function EmailTaskIcsSettings({ editor }: EmailTaskIcsSettingsProps) {
  const {
    t, serveScheduleIcs, setServeScheduleIcs, selectedTaskId, action, capability,
    copyPublicIcsLink, icsLinkMode, setIcsLinkMode, icsContentTemplate,
    setIcsContentTemplate, setIsDirty, openIcsPreview, openVariableReference,
  } = editor;

  return <>
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
          </div>
        </div>

        {serveScheduleIcs && <>
          <div class={s.formGroup}>
            <label class={s.label} for="ics-link-mode">{t('emailTaskIcsLinkMode')}</label>
            <select id="ics-link-mode" class={s.input} value={icsLinkMode} onChange={(e) => { setIsDirty(true); setIcsLinkMode((e.target as HTMLSelectElement).value as ScheduleIcsMode); }}>
              <option value="presenters">{t('emailTaskIcsLinkModePresenters')}</option>
              <option value="meeting">{t('emailTaskIcsLinkModeMeeting')}</option>
            </select>
          </div>

          <div class={s.formGroup}>
            <label class={s.label}>{t('emailTaskIcsContentTemplate')}</label>
            <CodeMirrorEditor value={icsContentTemplate} onChange={(value) => { setIsDirty(true); setIcsContentTemplate(value); }} />
            <div class={`${s.text12} ${s.textMuted}`}>{t('emailTaskIcsContentTemplateHint')}</div>
            <div class={s.flexGapSm}>
              <Button variant="secondary" onClick={openIcsPreview}>{t('emailTaskIcsPreview')}</Button>
              <Button variant="ghost" onClick={() => openVariableReference('ics')}>{t('templateVariableReference')}</Button>
            </div>
          </div>
        </>}

  </>;
}
