import type { AppRoute } from './lib/router.js';
import * as s from './styles/components.css.js';
import { PersonsPage } from './pages/PersonsPage.js';
import { KeywordList } from './components/KeywordList.js';
import { SchedulePage } from './pages/SchedulePage.js';
import { KeywordGraph } from './components/KeywordGraph.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { DataPanel } from './components/DataPanel.js';
import { TripletCard } from './components/TripletCard.js';

export function renderRoute(route: AppRoute) {
  if (route === '/persons') return <PersonsPage />;
  if (route === '/keywords') {
    return (
      <div>
        <KeywordList />
        <div class={s.sectionStack}>
          <TripletCard />
        </div>
      </div>
    );
  }

  if (route === '/schedule') return <SchedulePage />;

  if (route === '/graph') {
    return (
      <div>
        <KeywordGraph />
        <div class={s.sectionStack}>
          <TripletCard />
        </div>
      </div>
    );
  }

  if (route === '/settings') {
    return (
      <div>
        <SettingsPanel />
        <div class={s.sectionStack}>
          <DataPanel />
        </div>
      </div>
    );
  }

  return null;
}
