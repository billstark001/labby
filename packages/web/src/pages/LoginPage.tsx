/** Login page – only shown in server (API) mode. */
import { useState } from 'preact/hooks';
import { LogIn } from 'lucide-preact';
import { confirmPasswordReset, login, requestPasswordReset } from '../lib/auth';
import * as s from '../styles/components.css';
import { i18n } from '../i18n';

export function LoginPage() {
  const { t } = i18n;
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetIdentity, setResetIdentity] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(identity, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReset = async () => {
    setError(null);
    setResetMessage(null);
    try {
      await requestPasswordReset(resetIdentity);
      setResetMessage(t('passwordResetRequested'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmReset = async () => {
    setError(null);
    setResetMessage(null);
    try {
      await confirmPasswordReset(resetIdentity, resetCode, resetNewPassword);
      setResetMessage(t('passwordResetConfirmed'));
      setPassword('');
      setResetCode('');
      setResetNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div class={s.loginShell}>
      <div class={s.loginCard}>
        <div class={s.loginHeader}>
          <LogIn size={24} />
          <h1 class={s.loginTitle}>Labby</h1>
        </div>

        <form onSubmit={handleSubmit}>
          <div class={s.formGroup}>
            <label class={s.label} for="identity">{t('loginIdentity')}</label>
            <input
              id="identity"
              class={s.input}
              type="text"
              value={identity}
              onInput={e => setIdentity((e.target as HTMLInputElement).value)}
              disabled={loading}
              autoComplete="username"
              required
            />
          </div>

          <div class={s.formGroup}>
            <label class={s.label} for="password">{t('loginPassword')}</label>
            <input
              id="password"
              class={s.input}
              type="password"
              value={password}
              onInput={e => setPassword((e.target as HTMLInputElement).value)}
              disabled={loading}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <p class={s.loginError}>{error}</p>}

          <button
            type="submit"
            class={s.btnVariants['primary'] + ' ' + s.loginSubmit}
            disabled={loading}
          >
            {loading ? t('loggingIn') : t('loginSubmit')}
          </button>
        </form>

        <div class={s.formGroup}>
          <h3 class={`${s.text15} ${s.fontMedium}`}>{t('passwordResetTitle')}</h3>
          <p class={`${s.text12} ${s.textMuted}`}>{t('passwordResetHint')}</p>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('passwordResetIdentity')}</label>
          <input
            class={s.input}
            type="text"
            value={resetIdentity}
            onInput={e => setResetIdentity((e.target as HTMLInputElement).value)}
            placeholder={t('passwordResetIdentity')}
          />
          <div class={s.flexGapSm}>
            <button
              type="button"
              class={s.btnVariants.secondary}
              disabled={!resetIdentity.trim()}
              onClick={() => void handleRequestReset()}
            >
              {t('requestPasswordReset')}
            </button>
          </div>
          <div class={`${s.text12} ${s.textMuted}`}>{t('verificationCooldownHint')}</div>
        </div>

        <div class={s.formGroup}>
          <label class={s.label}>{t('verificationCode')}</label>
          <input
            class={s.input}
            type="text"
            value={resetCode}
            onInput={e => setResetCode((e.target as HTMLInputElement).value)}
          />
          <label class={s.label} for="resetNewPassword">{t('newPassword')}</label>
          <input
            id="resetNewPassword"
            class={s.input}
            type="password"
            value={resetNewPassword}
            onInput={e => setResetNewPassword((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            class={s.btnVariants.secondary}
            disabled={!resetIdentity.trim() || !resetCode.trim() || !resetNewPassword.trim()}
            onClick={() => void handleConfirmReset()}
          >
            {t('confirmPasswordReset')}
          </button>
        </div>

        {resetMessage && <p class={s.text12}>{resetMessage}</p>}
      </div>
    </div>
  );
}
