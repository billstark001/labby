/** Settings panel: language and config management. */
import { i18n } from '../i18n.js';
import type { Locale } from '../i18n.js';
import * as s from '../styles/components.css.js';
import { DataPanel } from '../components/DataPanel.js';
import { deploymentMode } from '../lib/runtime.js';
import clsx from 'clsx';

const locales: Locale[] = ['en', 'zh-CN', 'ja-JP'];
const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文',
  'ja-JP': '日本語',
};

export function SettingsPage() {
  const { t, lang, setLang } = i18n.useTranslation();
  return (
    <div>
      <h2 class={clsx(s.sectionTitle, s.mb12)}>{t('settingsTitle')}</h2>

      <div class={s.card}>
        <div class={s.formGroup}>
          <label class={s.label}>{t('languageLabel')}</label>
          <div class={s.flexGapSm}>
            {locales.map(locale => (
              <button
                key={locale}
                class={
                  lang === locale
                    ? s.btnVariants.primary
                    : s.btnVariants.secondary
                }
                onClick={() => setLang(locale)}
              >
                {localeLabels[locale]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class={clsx(s.card, s.sectionStack)}>
        <div class={clsx(s.flexBetween, s.mb12)}>
          <h3 class={clsx(s.text15, s.fontMedium)}>{t('deploymentModeTitle')}</h3>
          <span class={deploymentMode === 'server' ? s.badge : s.badgeDisabled}>
            {deploymentMode === 'server' ? t('deploymentModeServer') : t('deploymentModeFrontendOnly')}
          </span>
        </div>
        <p class={s.mutedParagraph}>
          {deploymentMode === 'server' ? t('deploymentModeServerHint') : t('deploymentModeFrontendHint')}
        </p>
      </div>

      <div class={s.sectionStack}>
        <DataPanel />
      </div>
    </div>
  );
}
