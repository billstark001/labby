/** Root application shell with sidebar navigation. */
import { h } from 'preact';
import { navSignal, t, type NavSection } from '../store/index.js';
import type { UIStrings } from '../i18n/translations.js';
import * as s from '../styles/components.css.js';
import { PersonList } from './PersonList.js';
import { KeywordList } from './KeywordList.js';
import { SchedulePanel } from './SchedulePanel.js';
import { KeywordGraph } from './KeywordGraph.js';
import { TripletCard } from './TripletCard.js';
import { DataPanel } from './DataPanel.js';
import { SettingsPanel } from './SettingsPanel.js';

const NAV_ITEMS: { key: NavSection; icon: string; labelKey: keyof UIStrings }[] = [
  { key: 'schedule', icon: '📅', labelKey: 'navSchedule' },
  { key: 'persons', icon: '👥', labelKey: 'navPersons' },
  { key: 'keywords', icon: '🏷️', labelKey: 'navKeywords' },
  { key: 'graph', icon: '🕸️', labelKey: 'navGraph' },
  { key: 'settings', icon: '⚙️', labelKey: 'navSettings' },
];

export function App() {
  const strings = t.value;
  const nav = navSignal.value;

  return (
    <div class={s.appShell}>
      {/* Sidebar */}
      <aside class={s.sidebar}>
        <div
          style={{
            fontWeight: 700,
            fontSize: '18px',
            marginBottom: '16px',
            color: '#2563eb',
          }}
        >
          📅 Labby
        </div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            class={nav === item.key ? s.navItemActive : s.navItem}
            onClick={() => (navSignal.value = item.key)}
          >
            {item.icon} {strings[item.labelKey]}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {/* Data import/export shortcut */}
        <button
          class={s.navItem}
          onClick={() => {
            // Open data panel in a simple inline toggle
            navSignal.value = 'settings';
          }}
          style={{ fontSize: '12px', color: '#94a3b8' }}
        >
          💾 Data
        </button>
      </aside>

      {/* Main content */}
      <main class={s.mainContent}>
        {nav === 'persons' && <PersonList />}
        {nav === 'keywords' && (
          <div>
            <KeywordList />
            <div style={{ marginTop: '32px' }}>
              <TripletCard />
            </div>
          </div>
        )}
        {nav === 'schedule' && <SchedulePanel />}
        {nav === 'graph' && <KeywordGraph />}
        {nav === 'settings' && (
          <div>
            <SettingsPanel />
            <div style={{ marginTop: '32px' }}>
              <DataPanel />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
