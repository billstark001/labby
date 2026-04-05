import { useState } from 'preact/hooks';

import { Button } from '@/components/ui';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';

import { PersonsTab } from './PersonsTab';
import { ConstraintsTab } from './ConstraintsTab';

export function PersonsPage() {
  const { t } = i18n;
  const [activeTab, setActiveTab] = useState<'persons' | 'constraints'>('persons');

  return (
    <div>
      <div class={s.toolbar}>
        <div class={s.flexGapSm}>
          <Button variant={activeTab === 'persons' ? 'primary' : 'ghost'} onClick={() => setActiveTab('persons')}>
            {t('navPersons')}
          </Button>
          <Button variant={activeTab === 'constraints' ? 'primary' : 'ghost'} onClick={() => setActiveTab('constraints')}>
            {t('constraintsTab')}
          </Button>
        </div>
      </div>

      {activeTab === 'persons' ? <PersonsTab /> : <ConstraintsTab />}
    </div>
  );
}
