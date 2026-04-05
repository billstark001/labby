import { useEffect } from 'preact/hooks';
import type { EmailTask } from '@labby/core';

import { Button, ResponsiveDataField, ResponsiveDataView, responsiveDataStyles as dataStyles, toast } from '@/components/ui';
import { confirmDialog } from '@/components/ui/Dialog';
import { loadAllConfigs, loadAllEmailTasks, useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { sendEmailTaskNow, setEmailTaskSkipNext } from '@/lib/email-task-actions';
import { getEmailTaskCapability } from '@/lib/email-task-capability';
import { navigate } from '@/lib/router';
import { getScheduleConfigLabel } from '@/lib/scheduleConfigLabel';
import { configsSignal, emailTasksSignal } from '@/store';
import * as s from '@/styles/components.css';

const DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function summarizeDays(days: number[]): string {
  return days
    .map((day) => DAY_OPTIONS.find((item) => item.value === day)?.label ?? String(day))
    .join(', ');
}

function summarizeEmails(task: EmailTask): string {
  if (task.emails.length === 0) return '—';
  const shown = task.emails.slice(0, 2).join(', ');
  if (task.emails.length <= 2) return shown;
  return `${shown} +${task.emails.length - 2}`;
}

export function EmailTasksListPage() {
  const { t } = i18n;
  const db = useDatabase();
  const capability = getEmailTaskCapability();
  const tasks = emailTasksSignal.value;
  const configs = configsSignal.value;

  useEffect(() => {
    void Promise.all([loadAllConfigs(db), loadAllEmailTasks(db)]);
  }, [db]);

  function findConfigLabel(configId: string): string {
    const config = configs.find((item) => item.id === configId);
    return config ? getScheduleConfigLabel(config) : configId;
  }

  async function removeTask(task: EmailTask): Promise<void> {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.emailTasks.delete(task.id);
      await loadAllEmailTasks(db);
    });
  }

  async function triggerSendNow(task: EmailTask): Promise<void> {
    if (!capability.canAutoSend) return;
    try {
      await sendEmailTaskNow(task.id);
      await loadAllEmailTasks(db);
      toast.success(t('emailTaskSendNowSuccess'));
    } catch (err) {
      toast.error(`${t('emailTaskSendNowFailed')}: ${String(err)}`);
    }
  }

  async function toggleSkipNext(task: EmailTask): Promise<void> {
    if (!capability.canAutoSend) return;
    const nextSkip = !(task.skipNextRun ?? false);
    try {
      await setEmailTaskSkipNext(task.id, nextSkip);
      await loadAllEmailTasks(db);
      toast.success(nextSkip ? t('emailTaskSkipNextEnabled') : t('emailTaskSkipNextDisabled'));
    } catch (err) {
      toast.error(`${t('emailTaskSkipNextFailed')}: ${String(err)}`);
    }
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navEmailTasks')}</h2>
        <Button variant="primary" onClick={() => navigate('/email-tasks/edit')}>
          + {t('newEmailTask')}
        </Button>
      </div>

      <div class={s.card}>
        <strong>{t('emailTaskList')}</strong>
        <div class={s.mt8}>
          <ResponsiveDataView
            items={tasks}
            columns={[
              { header: t('emailTaskConfig') },
              { header: t('emailTaskDays') },
              { header: t('emailTaskSendTime') },
              { header: t('emailTaskTimezone') },
              { header: t('emailTaskEmails') },
              { header: t('modifiedAt') },
            ]}
            empty={<p class={`${s.text14} ${s.textMuted}`}>{t('noEmailTasksYet')}</p>}
            getKey={(task) => task.id}
            renderDesktopRow={(task) => (
              <>
                <td class={s.td}>{findConfigLabel(task.configId)}</td>
                <td class={s.td}>{summarizeDays(task.daysOfWeek)}</td>
                <td class={s.td}>{task.sendTime ?? '09:00'}</td>
                <td class={s.td}>{task.timezone ?? 'UTC'}</td>
                <td class={s.td}>{summarizeEmails(task)}</td>
                <td class={s.td}>{task.modifiedAt ? new Date(task.modifiedAt).toLocaleString() : '—'}</td>
              </>
            )}
            renderMobileCard={(task) => (
              <>
                <div class={dataStyles.mobileHeader}>
                  <div class={dataStyles.mobileTitle}>{findConfigLabel(task.configId)}</div>
                  <div class={dataStyles.mobileSubtitle}>{task.modifiedAt ? new Date(task.modifiedAt).toLocaleString() : '—'}</div>
                </div>
                <div class={dataStyles.mobileFields}>
                  <ResponsiveDataField label={t('emailTaskDays')}>{summarizeDays(task.daysOfWeek)}</ResponsiveDataField>
                  <ResponsiveDataField label={t('emailTaskSendTime')}>{task.sendTime ?? '09:00'}</ResponsiveDataField>
                  <ResponsiveDataField label={t('emailTaskTimezone')}>{task.timezone ?? 'UTC'}</ResponsiveDataField>
                  <ResponsiveDataField label={t('emailTaskEmails')}>{summarizeEmails(task)}</ResponsiveDataField>
                </div>
              </>
            )}
            renderActions={(task) => (
              <>
                <Button variant="ghost" onClick={() => navigate(`/email-tasks/edit/${task.id}`)}>{t('edit')}</Button>
                {capability.canAutoSend && (
                  <>
                    <Button variant="secondary" onClick={() => void triggerSendNow(task)}>{t('emailTaskSendNow')}</Button>
                    <Button variant="ghost" onClick={() => void toggleSkipNext(task)}>
                      {task.skipNextRun ? t('emailTaskSkipNextCancel') : t('emailTaskSkipNext')}
                    </Button>
                  </>
                )}
                <Button variant="danger" onClick={() => void removeTask(task)}>{t('delete')}</Button>
              </>
            )}
          />
        </div>
      </div>
    </div>
  );
}
