/** Settings panel: language and config management. */
import { h } from 'preact';
import { localeSignal, t } from '../store/index.js';
import type { Locale } from '../i18n/translations.js';
import * as s from '../styles/components.css.js';

export function SettingsPanel() {
  const strings = t.value;
  const locales: Locale[] = ['en', 'zh', 'ja'];
  const localeLabels: Record<Locale, string> = {
    en: 'English',
    zh: '中文',
    ja: '日本語',
  };

  return (
    <div>
      <h2 class={s.sectionTitle}>{strings.settingsTitle}</h2>

      <div class={s.card}>
        <div class={s.formGroup}>
          <label class={s.label}>{strings.languageLabel}</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {locales.map(locale => (
              <button
                key={locale}
                class={
                  localeSignal.value === locale
                    ? s.btnVariants.primary
                    : s.btnVariants.secondary
                }
                onClick={() => (localeSignal.value = locale)}
              >
                {localeLabels[locale]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
