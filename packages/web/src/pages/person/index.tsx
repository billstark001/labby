import { useState } from 'preact/hooks';

import { Button, ContentSkeleton } from '@/components/ui';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import { isServerDeployment } from '@/lib/runtime';
import { fetchSystemCapabilities } from '@/api-server/backup';
import { useAsyncResource } from '@/lib/use-async-resource';

import { PersonsTab } from './PersonsTab';
import { TagsTab } from './TagsTab';
import { ConstraintsTab } from './ConstraintsTab';
import { UsersTab } from './UsersTab';

export function PersonsPage() {
  const { t } = i18n;
  const [activeTab, setActiveTab] = useState<'persons' | 'tags' | 'constraints' | 'users'>('persons');
  const capabilities = useAsyncResource(() => isServerDeployment ? fetchSystemCapabilities() : Promise.resolve(null));
  const canManageUsers = capabilities.data?.permissions.canManageUsers ?? false;
  const showUsersTab = isServerDeployment && canManageUsers;

  if (isServerDeployment && capabilities.isInitialLoading) return <ContentSkeleton rows={5} />;
  if (isServerDeployment && capabilities.error && !capabilities.data) return <div role="alert" class={s.card}>
    <p class={s.textDanger}>{String(capabilities.error)}</p>
    <Button variant="secondary" onClick={() => void capabilities.refetch()}>{t('retry')}</Button>
  </div>;

  return (
    <div>
      <div class={s.toolbar}>
        <div class={s.flexGapSm}>
          <Button variant={activeTab === 'persons' ? 'primary' : 'ghost'} onClick={() => setActiveTab('persons')}>
            {t('navPersons')}
          </Button>
          <Button variant={activeTab === 'tags' ? 'primary' : 'ghost'} onClick={() => setActiveTab('tags')}>
            {t('personTags')}
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
      {activeTab === 'tags' && <TagsTab />}
      {activeTab === 'constraints' && <ConstraintsTab />}
      {activeTab === 'users' && showUsersTab && <UsersTab canManageUsers={canManageUsers} />}
    </div>
  );
}
