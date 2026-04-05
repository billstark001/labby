import type { AppRoute } from './lib/router';
import { PersonsPage } from './pages/person';
import { SchedulePage } from './pages/SchedulePage';
import { SettingsPage } from './pages/SettingsPage';
import { KeywordsPage } from './pages/KeywordsPage';
import { LoginPage } from './pages/LoginPage';
import { EmailTasksPage } from './pages/EmailTasksPage';

export function renderRoute(route: AppRoute) {
  if (route === '/login') return <LoginPage />;
  if (route === '/persons') return <PersonsPage />;
  if (route === '/keywords') return <KeywordsPage />;
  if (route === '/email-tasks') return <EmailTasksPage />;
  if (route === '/schedule') return <SchedulePage />;
  if (route === '/settings') return <SettingsPage />;

  return null;
}
