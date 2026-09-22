/** Mount startup feedback before opening the local database. */
import { render } from 'preact';
import { signal } from '@preact/signals';
import { initDB } from './db/index';
import { App } from './App';
import { Toaster } from './components/ui/Toast';
import { ContentSkeleton } from './components/ui/Skeleton';
import { i18n } from './i18n';
import './styles/global.css';

const startupError = signal('');
function Startup() {
  return (
    <main style={{ padding: '2rem' }}>
      {startupError.value
        ? <><p role="alert">{startupError.value}</p><button onClick={() => window.location.reload()}>{i18n.t('retry')}</button></>
        : <ContentSkeleton rows={5} />}
      <Toaster />
    </main>
  );
}
render(<Startup />, document.getElementById('app')!);
initDB()
  .then(() => {
    render(<App />, document.getElementById('app')!);
  })
  .catch((error) => {
    startupError.value = String(error);
  });
