/** Settings panel: language and config management. */
import { useEffect, useState } from 'preact/hooks';

import { i18n } from '../i18n';
import type { Locale } from '../i18n';
import * as s from '../styles/components.css';
import { DataPanel } from '../components/DataPanel';
import { deploymentMode } from '../lib/runtime';
import {
  changePassword,
  confirmEmailChange,
  confirmEmailVerification,
  getAccountProfile,
  requestEmailChange,
  requestEmailVerification,
  type AuthAccountProfile,
} from '../lib/auth';
import clsx from 'clsx';

const locales: Locale[] = ['en', 'zh-CN', 'ja-JP'];
const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文',
  'ja-JP': '日本語',
};

export function SettingsPage() {
  const { t, lang, setLang } = i18n.useTranslation();
  const [profile, setProfile] = useState<AuthAccountProfile | null>(null);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailChangePassword, setEmailChangePassword] = useState('');
  const [emailChangeCode, setEmailChangeCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const isRoot = profile?.role === 2;

  useEffect(() => {
    if (deploymentMode !== 'server') return;
    void getAccountProfile()
      .then(setProfile)
      .catch((err) => setSecurityError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function handleRequestVerifyEmail() {
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      await requestEmailVerification();
      setSecurityMessage(t('emailVerificationRequested'));
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmVerifyEmail() {
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      await confirmEmailVerification(emailCode);
      setSecurityMessage(t('emailVerificationConfirmed'));
      setEmailCode('');
      setProfile(await getAccountProfile());
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRequestChangeEmail() {
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      await requestEmailChange(emailChangePassword, newEmail);
      setSecurityMessage(t('emailChangeRequested'));
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmChangeEmail() {
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      await confirmEmailChange(emailChangeCode);
      setSecurityMessage(t('emailChangeConfirmed'));
      setEmailChangeCode('');
      setEmailChangePassword('');
      setNewEmail('');
      setProfile(await getAccountProfile());
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleChangePassword() {
    setSecurityError(null);
    setSecurityMessage(null);
    try {
      await changePassword(currentPassword, newPassword);
      setSecurityMessage(t('passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : String(err));
    }
  }

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

      {deploymentMode === 'server' && (
        <div class={clsx(s.card, s.sectionStack)}>
          <h3 class={clsx(s.text15, s.fontMedium)}>{t('accountSecurityTitle')}</h3>
          <p class={s.mutedParagraph}>
            {profile
              ? `${profile.username} (${profile.email ?? t('emailNotSet')})`
              : t('serverCapabilitiesLoading')}
          </p>
          <p class={s.mutedParagraph}>{t('verificationCooldownHint')}</p>
          {isRoot && <p class={s.mutedParagraph}>{t('rootSecurityReadonlyHint')}</p>}

          <div class={s.formGroup}>
            <label class={s.label}>{t('verificationCode')}</label>
            <input class={s.input} value={emailCode} disabled={isRoot} onInput={(e) => setEmailCode((e.target as HTMLInputElement).value)} />
            <div class={s.flexGapSm}>
              <button class={s.btnVariants.secondary} disabled={isRoot} onClick={() => void handleRequestVerifyEmail()}>{t('requestEmailVerification')}</button>
              <button class={s.btnVariants.secondary} disabled={isRoot} onClick={() => void handleConfirmVerifyEmail()}>{t('confirmEmailVerification')}</button>
            </div>
          </div>

          <div class={s.formGroup}>
            <label class={s.label}>{t('newEmail')}</label>
            <input class={s.input} type="email" disabled={isRoot} value={newEmail} onInput={(e) => setNewEmail((e.target as HTMLInputElement).value)} />
            <label class={s.label}>{t('currentPassword')}</label>
            <input class={s.input} type="password" disabled={isRoot} value={emailChangePassword} onInput={(e) => setEmailChangePassword((e.target as HTMLInputElement).value)} />
            <button class={s.btnVariants.secondary} disabled={isRoot} onClick={() => void handleRequestChangeEmail()}>{t('requestEmailChange')}</button>
            <label class={s.label}>{t('verificationCode')}</label>
            <input class={s.input} value={emailChangeCode} disabled={isRoot} onInput={(e) => setEmailChangeCode((e.target as HTMLInputElement).value)} />
            <button class={s.btnVariants.secondary} disabled={isRoot} onClick={() => void handleConfirmChangeEmail()}>{t('confirmEmailChange')}</button>
          </div>

          <div class={s.formGroup}>
            <label class={s.label}>{t('currentPassword')}</label>
            <input class={s.input} type="password" disabled={isRoot} value={currentPassword} onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)} />
            <label class={s.label}>{t('newPassword')}</label>
            <input class={s.input} type="password" disabled={isRoot} value={newPassword} onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)} />
            <button class={s.btnVariants.secondary} disabled={isRoot} onClick={() => void handleChangePassword()}>{t('changePasswordAction')}</button>
          </div>

          {securityMessage && <p class={s.text12}>{securityMessage}</p>}
          {securityError && <p class={s.textDanger}>{securityError}</p>}
        </div>
      )}

      <div class={s.sectionStack}>
        <DataPanel />
      </div>
    </div>
  );
}
