import { useState } from 'preact/hooks';

import { Button, Dialog } from '@/components/ui';
import { i18n } from '@/i18n';
import { confirmPasswordReset, requestPasswordReset } from '@/lib/auth';
import * as s from '@/styles/components.css';

interface ForgotPasswordDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ForgotPasswordDialog({ open, onClose }: ForgotPasswordDialogProps) {
  const { t } = i18n;
  const [resetIdentity, setResetIdentity] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleRequestReset(): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await requestPasswordReset(resetIdentity);
      setMessage(t('passwordResetRequested'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmReset(): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await confirmPasswordReset(resetIdentity, resetCode, resetNewPassword);
      setMessage(t('passwordResetConfirmed'));
      setResetCode('');
      setResetNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('passwordResetTitle')}>
      <div class={s.formGroup}>
        <p class={`${s.text12} ${s.textMuted}`}>{t('passwordResetHint')}</p>
      </div>

      <div class={s.formGroup}>
        <label class={s.label}>{t('passwordResetIdentity')}</label>
        <input
          class={s.input}
          type="text"
          value={resetIdentity}
          onInput={(e) => setResetIdentity((e.target as HTMLInputElement).value)}
          placeholder={t('passwordResetIdentity')}
        />
        <div class={s.flexGapSm}>
          <Button variant="secondary" disabled={!resetIdentity.trim()} onClick={() => void handleRequestReset()}>
            {t('requestPasswordReset')}
          </Button>
        </div>
        <div class={`${s.text12} ${s.textMuted}`}>{t('verificationCooldownHint')}</div>
      </div>

      <div class={s.formGroup}>
        <label class={s.label}>{t('verificationCode')}</label>
        <input
          class={s.input}
          type="text"
          value={resetCode}
          onInput={(e) => setResetCode((e.target as HTMLInputElement).value)}
        />
        <label class={s.label}>{t('newPassword')}</label>
        <input
          class={s.input}
          type="password"
          value={resetNewPassword}
          onInput={(e) => setResetNewPassword((e.target as HTMLInputElement).value)}
        />
        <Button
          variant="secondary"
          disabled={!resetIdentity.trim() || !resetCode.trim() || !resetNewPassword.trim()}
          onClick={() => void handleConfirmReset()}
        >
          {t('confirmPasswordReset')}
        </Button>
      </div>

      {error && <p class={s.loginError}>{error}</p>}
      {message && <p class={s.text12}>{message}</p>}

      <div class={s.flexGapSm}>
        <Button variant="ghost" onClick={onClose}>{t('close')}</Button>
      </div>
    </Dialog>
  );
}
