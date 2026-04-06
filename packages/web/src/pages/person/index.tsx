import { useEffect, useState } from 'preact/hooks';

import { Button } from '@/components/ui';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import { isServerDeployment } from '@/lib/runtime';
import { fetchSystemCapabilities } from '@/lib/server-backup';

import { PersonsTab } from './PersonsTab';
import { ConstraintsTab } from './ConstraintsTab';
import { UsersTab } from './UsersTab';

export function PersonsPage() {
  const { t } = i18n;
  const [activeTab, setActiveTab] = useState<'persons' | 'constraints' | 'users'>('persons');
  const [canManageUsers, setCanManageUsers] = useState(false);

  useEffect(() => {
    if (!isServerDeployment) return;
    fetchSystemCapabilities().then((caps) => {
      setCanManageUsers(caps.permissions.canManageUsers);
    }).catch(() => {
      setCanManageUsers(false);
    });
  }, []);

  const showUsersTab = isServerDeployment && canManageUsers;

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
          {showUsersTab && (
            <Button variant={activeTab === 'users' ? 'primary' : 'ghost'} onClick={() => setActiveTab('users')}>
              {t('usersTab')}
            </Button>
          )}
        </div>
      </div>

      {activeTab === 'persons' && <PersonsTab />}
      {activeTab === 'constraints' && <ConstraintsTab />}
      {activeTab === 'users' && showUsersTab && <UsersTab canManageUsers={canManageUsers} />}
    </div>
  );
}
