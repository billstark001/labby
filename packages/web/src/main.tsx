/** Application entry point. Loads data from IndexedDB and mounts Preact app. */
import { render } from 'preact';
import {
  keywordsSignal,
  embeddingsSignal,
  schedulesSignal,
  currentScheduleSignal,
} from './store/index.js';
import { initDB, loadDatabaseSignals } from './db/index.js';
import { initEmbeddings } from '@labby/core';
import { App } from './App.js';

// Import vanilla-extract global styles (registers CSS via side-effects)
import './styles/global.css.js';

async function bootstrap() {
  const db = await initDB();
  await loadDatabaseSignals(db);

  // Set most-recent schedule as current
  if (schedulesSignal.value.length > 0) {
    const latest = schedulesSignal.value.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    currentScheduleSignal.value = latest;
  }

  // Initialize embeddings for keywords not yet tracked
  embeddingsSignal.value = initEmbeddings(keywordsSignal.value.map(k => k.id));

  render(<App />, document.getElementById('app')!);
}

bootstrap().catch(console.error);
