import { useMemo } from 'preact/hooks';

import { Button, Dialog } from '@/components/ui';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';

export type EmailAttachmentType = 'schedule-semester-csv' | 'schedule-semester-ics';

interface AttachmentSettingsDialogProps {
  open: boolean;
  selected: EmailAttachmentType[];
  onChange: (selected: EmailAttachmentType[]) => void;
  onClose: () => void;
}

const ALL_ATTACHMENT_TYPES: EmailAttachmentType[] = ['schedule-semester-csv', 'schedule-semester-ics'];

export function AttachmentSettingsDialog(props: AttachmentSettingsDialogProps) {
  const { t } = i18n;

  const selectedSet = useMemo(() => new Set(props.selected), [props.selected]);

  function toggle(type: EmailAttachmentType): void {
    const next = new Set(props.selected);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    props.onChange(ALL_ATTACHMENT_TYPES.filter((item) => next.has(item)));
  }

  const selectedCount = props.selected.length;

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t('emailTaskAttachments')}>
      <div class={s.formGroup}>
        <p class={`${s.text12} ${s.textMuted}`}>{t('emailTaskAttachmentDialogHint')}</p>
      </div>

      <div class={s.formGroup}>
        <label class={s.flexGapSm}>
          <input
            type="checkbox"
            checked={selectedSet.has('schedule-semester-csv')}
            onChange={() => toggle('schedule-semester-csv')}
          />
          <span>{t('emailTaskAttachmentCsv')}</span>
        </label>
        <label class={s.flexGapSm}>
          <input
            type="checkbox"
            checked={selectedSet.has('schedule-semester-ics')}
            onChange={() => toggle('schedule-semester-ics')}
          />
          <span>{t('emailTaskAttachmentIcs')}</span>
        </label>
      </div>

      <div class={s.formGroup}>
        <p class={`${s.text12} ${s.textMuted}`}>
          {selectedCount === 0 ? t('emailTaskAttachmentNoneHint') : t('emailTaskAttachmentDialogSelectedHint', String(selectedCount))}
        </p>
      </div>

      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={props.onClose}>{t('confirm')}</Button>
        <Button variant="secondary" onClick={props.onClose}>{t('close')}</Button>
      </div>
    </Dialog>
  );
}
