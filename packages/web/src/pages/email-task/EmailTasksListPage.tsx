import { useState } from 'preact/hooks';
import type { EmailTask } from '@labby/core';

import { Button, ContentSkeleton, ResponsiveDataField, ResponsiveDataView, responsiveDataStyles as dataStyles, toast } from '@/components/ui';
import { readAllPaginated, useDatabase } from '@/db';
import { i18n } from '@/i18n';
import { setEmailTaskSkipNext } from '@/api-server/email-tasks';
import { getEmailTaskCapability } from '@/lib/email-task-capability';
import { getPublicEmailTaskIcsUrl } from '@/lib/email-task-ics';
import { formatLocalDateTime24 } from '@/lib/date-time';
import { navigate } from '@/lib/router';
import { getScheduleConfigLabel } from '@/lib/scheduleConfigLabel';
import { useAsyncResource } from '@/lib/use-async-resource';
import { usePendingAction } from '@/lib/use-pending-action';
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

function summarizeCadence(task: EmailTask): string {
  return `${summarizeDays(task.daysOfWeek)} · ${task.sendTime ?? '09:00'} · ${task.timezone ?? 'UTC'}`;
}

export function EmailTasksListPage() {
  const { t } = i18n;
  const db = useDatabase();
  const capability = getEmailTaskCapability();
  const action = usePendingAction();
  const [sort, setSort] = useState<{key:string;direction:'asc'|'desc'}>({key:'modifiedAt',direction:'desc'});
  const query = useAsyncResource(async () => {
    const [tasks, configs] = await Promise.all([
      readAllPaginated(db.emailTasks),
      readAllPaginated(db.configs),
    ]);
    return { tasks, configs };
  }, [db]);
  const tasks = query.data?.tasks ?? [];
  const configs = query.data?.configs ?? [];

  function findConfigLabel(configId: string): string {
    const config = configs.find((item) => item.id === configId);
    return config ? getScheduleConfigLabel(config) : configId;
  }

  async function toggleDisabled(task: EmailTask): Promise<void> {
    await action.run(`disabled:${task.id}`, async () => {
      await db.emailTasks.put({ ...task, disabled: !task.disabled, modifiedAt: Date.now() });
      await query.refetch();
    });
  }

  async function toggleSkipNext(task: EmailTask): Promise<void> {
    if (!capability.canAutoSend) return;
    const nextSkip = !(task.skipNextRun ?? false);
    await action.run(`skip:${task.id}`, async () => {
      await setEmailTaskSkipNext(task.id, nextSkip);
      await query.refetch();
      toast.success(nextSkip ? t('emailTaskSkipNextEnabled') : t('emailTaskSkipNextDisabled'));
    });
  }

  async function copyIcsLink(task: EmailTask): Promise<void> {
    if (!capability.canAutoSend) return;
    await action.run(`copy:${task.id}`, async () => {
      await navigator.clipboard.writeText(getPublicEmailTaskIcsUrl(task.id));
      toast.success(t('emailTaskIcsLinkCopied'));
    });
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navEmailTasks')}</h2>
        <Button variant="primary" onClick={() => navigate('/email-tasks/edit')}>
          + {t('newEmailTask')}
        </Button>
      </div>

      {query.isInitialLoading ? <ContentSkeleton rows={5} /> : query.error && !query.data ? (
        <div role="alert" class={s.card}>
          <p class={s.textDanger}>{String(query.error)}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button>
        </div>
      ) : <div class={s.card} aria-busy={query.isRefetching}>
        {query.error && <p role="alert" class={s.textDanger}>{String(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>{t('retry')}</Button></p>}
        <strong>{t('emailTaskList')}</strong>
        <div class={s.mt8}>
          <ResponsiveDataView
            items={[...tasks].sort((a,b) => {
              const value = (task: EmailTask): string | number => sort.key === 'modifiedAt' ? task.modifiedAt ?? 0
                : sort.key === 'config' ? findConfigLabel(task.configId)
                : sort.key === 'cadence' ? summarizeCadence(task) : task.emails.join(', ');
              const left=value(a), right=value(b);
              const result=typeof left==='number' && typeof right==='number' ? left-right : String(left).localeCompare(String(right), i18n.lang.value, {numeric:true});
              return (sort.direction==='asc'?result:-result) || a.id.localeCompare(b.id);
            })}
            sorting={{...sort,options:[
              {key:'config',label:t('emailTaskConfig')}, {key:'cadence',label:t('emailTaskCadence')},
              {key:'emails',label:t('emailTaskEmails')}, {key:'modifiedAt',label:t('modifiedAt'),defaultDirection:'desc'},
            ],onChange:(key,direction)=>setSort({key,direction})}}
            columns={[
              { header: t('emailTaskConfig'), sortKey:'config' },
              { header: t('emailTaskCadence'), sortKey:'cadence' },
              { header: t('emailTaskEmails'), sortKey:'emails' },
              { header: t('modifiedAt'), sortKey:'modifiedAt' },
            ]}
            empty={<p class={`${s.text14} ${s.textMuted}`}>{t('noEmailTasksYet')}</p>}
            getKey={(task) => task.id}
            renderDesktopRow={(task) => (
              <>
                <td class={s.td}>
                  <div class={s.flexGapXs}>
                    <span>{findConfigLabel(task.configId)}</span>
                    {task.disabled && <span class={s.badgeDisabled}>{t('disabled')}</span>}
                  </div>
                </td>
                <td class={s.td}>{summarizeCadence(task)}</td>
                <td class={s.td}>{summarizeEmails(task)}</td>
                <td class={s.td}>{task.modifiedAt ? formatLocalDateTime24(task.modifiedAt) : '—'}</td>
              </>
            )}
            renderMobileCard={(task) => (
              <>
                <div class={dataStyles.mobileHeader}>
                  <div>
                    <div class={dataStyles.mobileTitle}>{findConfigLabel(task.configId)}</div>
                    <div class={dataStyles.mobileSubtitle}>{task.modifiedAt ? formatLocalDateTime24(task.modifiedAt) : '—'}</div>
                  </div>
                  {task.disabled && <span class={s.badgeDisabled}>{t('disabled')}</span>}
                </div>
                <div class={dataStyles.mobileFields}>
                  <ResponsiveDataField label={t('emailTaskCadence')}>{summarizeCadence(task)}</ResponsiveDataField>
                  <ResponsiveDataField label={t('emailTaskEmails')}>{summarizeEmails(task)}</ResponsiveDataField>
                </div>
              </>
            )}
            renderActions={(task) => (
              <>
                <Button variant="ghost" onClick={() => navigate(`/email-tasks/edit/${task.id}`)}>{t('edit')}</Button>
                <Button variant="ghost" busy={action.pendingKey === `disabled:${task.id}`} disabled={action.pendingKey !== null} onClick={() => void toggleDisabled(task)}>
                  {task.disabled ? t('enable') : t('disable')}
                </Button>
                {capability.canAutoSend && (
                  <>
                    {(task.metadata?.serveScheduleIcs as boolean | undefined) === true && (
                      <Button variant="ghost" busy={action.pendingKey === `copy:${task.id}`} disabled={action.pendingKey !== null} onClick={() => void copyIcsLink(task)}>
                        {t('emailTaskCopyIcsLink')}
                      </Button>
                    )}
                    <Button variant="ghost" busy={action.pendingKey === `skip:${task.id}`} disabled={action.pendingKey !== null} onClick={() => void toggleSkipNext(task)}>
                      {task.skipNextRun ? t('emailTaskSkipNextCancel') : t('emailTaskSkipNext')}
                    </Button>
                  </>
                )}
              </>
            )}
          />
        </div>
      </div>}
    </div>
  );
}
