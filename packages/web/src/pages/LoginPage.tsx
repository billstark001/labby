/** Login page – only shown in server (API) mode. */
import { useState } from 'preact/hooks';
import { LogIn } from 'lucide-preact';
import { login } from '../lib/auth';
import * as s from '../styles/components.css';
import { i18n } from '../i18n';

export function LoginPage() {
  const { t } = i18n;
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      </div>
    </div>
  );
}
