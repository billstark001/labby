import type { AppRoute } from './lib/router';
import { PersonsPage } from './pages/PersonsPage';
import { SchedulePage } from './pages/SchedulePage';
import { SettingsPage } from './pages/SettingsPage';
import { KeywordsPage } from './pages/KeywordsPage';
import { LoginPage } from './pages/LoginPage';

export function renderRoute(route: AppRoute) {
  if (route === '/login') return <LoginPage />;
  if (route === '/persons') return <PersonsPage />;
  if (route === '/keywords') return <KeywordsPage />;
  if (route === '/schedule') return <SchedulePage />;
  if (route === '/settings') return <SettingsPage />;

  return null;
}
