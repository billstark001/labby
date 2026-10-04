import { Button, ContentSkeleton } from '@/components/ui';
import { readAllPaginated, useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { navigate } from '@/lib/router';
import { useAsyncResource } from '@/lib/use-async-resource';
import * as s from '@/styles/components.css';
import { EmailTaskEditor } from './EmailTaskEditor';

interface EmailTaskEditPageProps {
  taskId?: string;
}

export function EmailTaskEditPage({ taskId }: EmailTaskEditPageProps) {
  const db = useDatabase();
  const { t } = i18n;
  const query = useAsyncResource(async () => {
    const [task, configs, persons, schedules, settings] = await Promise.all([
      taskId ? db.emailTasks.get(taskId) : Promise.resolve(undefined),
      readAllPaginated(db.configs),
      readAllPaginated(db.persons),
      readAllPaginated(db.schedules),
      db.systemSettings.get(),
    ]);
    return { task, configs, persons, schedules, systemTimezone: settings.timezone };
  }, [db, taskId]);

  if (query.isInitialLoading) return <ContentSkeleton rows={8} />;
  if (query.error || !query.data) return <div role="alert" class={s.card}>
    <p class={s.textDanger}>{String(query.error)}</p>
    <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button>
  </div>;
  if (taskId && !query.data.task) return <div class={s.card}>
    <p class={s.textDanger}>{t('emailTaskNotFound')}</p>
    <Button variant="secondary" onClick={() => navigate('/email-tasks')}>{t('backToList')}</Button>
  </div>;

  return <EmailTaskEditor key={taskId ?? '__new__'} taskId={taskId} {...query.data} />;
}
