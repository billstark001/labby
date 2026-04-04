/** Application entry point. Loads data from IndexedDB (or API) and mounts Preact app. */
import { render } from 'preact';
import { initDB } from './db/index';
import { App } from './App';

// Import vanilla-extract global styles (registers CSS via side-effects)
import './styles/global.css';

async function bootstrap() {
  await initDB();

  render(<App />, document.getElementById('app')!);
}

bootstrap().catch(console.error);
