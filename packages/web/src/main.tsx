/** Application entry point. Loads data from IndexedDB and mounts Preact app. */
import { render } from 'preact';
import {
  personsSignal,
  keywordsSignal,
  similarityEdgesSignal,
  embeddingsSignal,
  configsSignal,
  schedulesSignal,
  currentScheduleSignal,
  unavailabilitiesSignal,
} from './store/index.js';
import { db } from './db/index.js';
import { initEmbeddings } from '@labby/core';
import { App } from './App.js';

// Import vanilla-extract global styles (registers CSS via side-effects)
import './styles/global.css.js';

async function bootstrap() {
  // Load all data from IndexedDB into signals
  const [persons, keywords, similarities, configs, schedules, unavailabilities] = await Promise.all([
    db.persons.getAll(),
    db.keywords.getAll(),
    db.similarities.getAll(),
    db.configs.getAll(),
    db.schedules.getAll(),
    db.unavailabilities.getAll(),
  ]);

  personsSignal.value = persons;
  keywordsSignal.value = keywords;
  similarityEdgesSignal.value = similarities;
  configsSignal.value = configs;
  schedulesSignal.value = schedules;
  unavailabilitiesSignal.value = unavailabilities;

  // Set most-recent schedule as current
  if (schedules.length > 0) {
    const latest = schedules.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    currentScheduleSignal.value = latest;
  }

  // Initialise embeddings for keywords not yet tracked
  embeddingsSignal.value = initEmbeddings(keywords.map(k => k.id));

  render(<App />, document.getElementById('app')!);
}

bootstrap().catch(console.error);
