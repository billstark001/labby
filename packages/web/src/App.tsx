/** Root application shell with sidebar navigation. */
import { useEffect, useState } from 'preact/hooks';
import { effect, useComputed } from '@preact/signals';
import { Calendar, LogOut, Mail, Menu, Moon, Settings, Sun, Tags, Users, X } from 'lucide-preact';
import { themeSignal } from './store/index';
import { AUTH_INVALIDATE_EVENT, isAuthenticated, logout } from './lib/auth';
import { i18n } from './i18n';
import type { UIStrings } from './i18n';
import * as s from './styles/components.css';
import { navigate, useRoute, useSyncRoute, type AppRoute } from './lib/router';
import { renderRoute } from './route';
import { ConfirmDialogComponent } from './components/ui/Dialog';
import { Toaster } from './components/ui/Toast';
import { isServerDeployment } from './lib/runtime';
import clsx from 'clsx';

const NAV_ITEMS: { key: AppRoute; icon: typeof Calendar; labelKey: keyof UIStrings }[] = [
  { key: '/schedule', icon: Calendar, labelKey: 'navSchedule' },
  { key: '/persons', icon: Users, labelKey: 'navPersons' },
  { key: '/keywords', icon: Tags, labelKey: 'navKeywords' },
  { key: '/email-tasks', icon: Mail, labelKey: 'navEmailTasks' },
  // { key: '/graph', icon: GitBranch, labelKey: 'navGraph' },
  { key: '/settings', icon: Settings, labelKey: 'navSettings' },
];

if (typeof window !== 'undefined') {
  // Sync theme to DOM and localStorage on every change.
  effect(() => {
    const theme = themeSignal.value;
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add(`theme-${theme}`);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  });

}

export function App() {
  useSyncRoute();
  const { t } = i18n;
  const route = useRoute();
  const theme = themeSignal.value;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const authed = useComputed(() => isAuthenticated.value);

  useEffect(() => {
    if (!isServerDeployment) return;
    const onInvalidate = () => navigate('/login');
    window.addEventListener(AUTH_INVALIDATE_EVENT, onInvalidate);
    return () => window.removeEventListener(AUTH_INVALIDATE_EVENT, onInvalidate);
  }, []);

  // In server mode, redirect unauthenticated users to the login page
  if (isServerDeployment && !authed.value && route !== '/login') {
    navigate('/login');
    return null;
  }
  // Redirect authenticated users away from the login page
  if (isServerDeployment && authed.value && route === '/login') {
    navigate('/schedule');
    return null;
  }

  // Show login page without the shell chrome
  if (route === '/login') {
    return (
      <>
        {renderRoute(route)}
        <ConfirmDialogComponent />
        <Toaster />
      </>
    );
  }

  const toggleTheme = () => {
    themeSignal.value = themeSignal.value === 'light' ? 'dark' : 'light';
  };

  const handleNavigate = (path: AppRoute) => {
    navigate(path);
    setSidebarOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div class={s.appShell}>
      <header class={s.mobileTopbar}>
        <button
          class={s.navIconButton}
          onClick={() => setSidebarOpen(prev => !prev)}
          title={sidebarOpen ? t('close') : t('navSettings')}
        >
          {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <div class={s.appBrandMobile}>
          <Calendar size={16} />
          <span>Labby</span>
        </div>
        <button
          class={s.navIconButton}
          onClick={toggleTheme}
          title={theme === 'light' ? t('darkMode') : t('lightMode')}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
      </header>

      {/* Sidebar */}
      <aside class={`${s.sidebar} ${sidebarOpen ? s.sidebarOpen : s.sidebarClosed}`}>
        <div class={s.appBrand}>
          <Calendar size={18} />
          <span>Labby</span>
        </div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            class={route === item.key ? s.navItemActive : s.navItem}
            onClick={() => handleNavigate(item.key)}
          >
            <item.icon size={16} />
            {t(item.labelKey)}
          </button>
        ))}
        <div class={s.flex1} />
        {/* Theme toggle – hidden on mobile because the topbar already has one */}
        <button
          class={clsx(s.navIconButtonDesktop, s.hideOnMobile)}
          onClick={toggleTheme}
          title={theme === 'light' ? t('darkMode') : t('lightMode')}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        {isServerDeployment && authed.value && (
          <button
            class={s.navIconButtonDesktop}
            onClick={handleLogout}
            title={t('logout')}
          >
            <LogOut size={16} />
            <span class={s.hideOnMobile}>{t('logout')}</span>
          </button>
        )}
      </aside>

      {/* Main content */}
      <main class={s.mainContent}>
        {renderRoute(route)}
      </main>
      <ConfirmDialogComponent />
      <Toaster />
    </div>
  );
}
