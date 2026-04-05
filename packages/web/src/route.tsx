import type { AppRoute } from './lib/router';
import { PersonsPage } from './pages/person';
import { SchedulePage } from './pages/schedule';
import { SettingsPage } from './pages/SettingsPage';
import { KeywordsPage } from './pages/KeywordsPage';
import { LoginPage } from './pages/LoginPage';
import { EmailTaskEditPage, EmailTasksListPage } from './pages/email-task';

export function renderRoute(route: AppRoute) {
  if (route === '/login') return <LoginPage />;
  if (route === '/persons') return <PersonsPage />;
  if (route === '/keywords') return <KeywordsPage />;
  if (route === '/email-tasks') return <EmailTasksListPage />;
  if (route === '/email-tasks/edit') return <EmailTaskEditPage />;
  if (route.startsWith('/email-tasks/edit/')) {
    const taskId = decodeURIComponent(route.slice('/email-tasks/edit/'.length));
    return <EmailTaskEditPage taskId={taskId} />;
  }
  if (route === '/schedule') return <SchedulePage />;
  if (route === '/settings') return <SettingsPage />;

  return null;
}
