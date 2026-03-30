import type { AppRoute } from './lib/router.js';
import { PersonsPage } from './pages/PersonsPage.js';
import { SchedulePage } from './pages/SchedulePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { KeywordsPage } from './pages/KeywordsPage.js';

export function renderRoute(route: AppRoute) {

  if (route === '/persons') return <PersonsPage />;
  if (route === '/keywords') return <KeywordsPage />;
  if (route === '/schedule') return <SchedulePage />;
  if (route === '/settings') return <SettingsPage />;

  return null;
}
