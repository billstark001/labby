/** Application entry point. Loads data from IndexedDB (or API) and mounts Preact app. */
import { render } from 'preact';
import {
  embeddingsSignal,
} from './store/index';
import { initDB } from './db/index';
import { App } from './App';

// Import vanilla-extract global styles (registers CSS via side-effects)
import './styles/global.css';

async function bootstrap() {
  await initDB();

  // Embeddings initialize lazily per-page; keep a safe empty baseline here.
  embeddingsSignal.value = new Map();

  render(<App />, document.getElementById('app')!);
}

bootstrap().catch(console.error);
