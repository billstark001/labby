import type { TemplateRenderError } from '@labby/core';
import * as s from '@/styles/components.css';
import * as styles from './TemplatePreview.css';
import { i18n } from '@/i18n';
import { AlertTriangle } from 'lucide-preact';

export function TemplateErrors({ errors, icsError = '' }: { errors: TemplateRenderError[]; icsError?: string }) {
  if (errors.length === 0 && !icsError) return null;
  return <section role="alert" class={styles.warning}>
    <div class={s.flexGapSm}><AlertTriangle size={20} aria-hidden="true" /><strong>{i18n.t('emailTemplateWarningTitle')}</strong></div>
    <p>{i18n.t('emailTemplateWarningBody')}</p>
    <ul class={styles.errorList}>
      {errors.map((error, index) => <li key={index}>{error.message}</li>)}
      {icsError && <li>ICS: {icsError}</li>}
    </ul>
  </section>;
}

export function EmailPreviewContent({ html }: { html: string }) {
  return <div class={s.card}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}
