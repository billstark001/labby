/** Data import/export: MsgPack backup, HTML table, CSV via PapaParse. */
import { encode, decode } from '@msgpack/msgpack';
import { dumpDatabase, loadDatabaseSignals, restoreDatabase, useDatabase } from '../db/index';
import * as s from '../styles/components.css';
import { Button, ContentSkeleton } from './ui';
import { i18n } from '@/i18n';
import { toast } from './ui';
import {
  downloadServerBackup,
  fetchSystemCapabilities,
  runServerBackup,
  uploadServerBackup,
  type BackupTarget,
  type SystemCapabilities,
} from '@/api-server/backup';
import { deploymentMode, isFrontendOnlyDeployment, isServerDeployment } from '@/lib/runtime';
import clsx from 'clsx';
import { confirmDialog } from './ui/Dialog';
import { useAsyncResource } from '@/lib/use-async-resource';
import { usePendingAction } from '@/lib/use-pending-action';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataPanel() {
  const { t } = i18n;
  const dbInstance = useDatabase();
  const action = usePendingAction();
  const capabilitiesQuery = useAsyncResource<SystemCapabilities | null>(
    () => isServerDeployment ? fetchSystemCapabilities({ force: true }) : Promise.resolve(null),
  );
  const capabilities = capabilitiesQuery.data;

  const canManageServerBackups = Boolean(capabilities?.permissions.canManageBackups);

  async function handleExportBackup() {
    const id = toast.loading(t('computing'));
    try {
      const dump = await dumpDatabase();
      const packed = encode(dump);
      triggerDownload(new Blob([packed], { type: 'application/octet-stream' }), 'labby-backup.labby');
      toast.dismiss(id);
      toast.success(t('exportSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  async function handleExportJson() {
    const id = toast.loading(t('computing'));
    try {
      const dump = await dumpDatabase();
      const json = JSON.stringify(dump, null, 2);
      triggerDownload(new Blob([json], { type: 'application/json' }), 'labby-backup.json');
      toast.dismiss(id);
      toast.success(t('exportSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  async function importLocalBackup(file: File) {
    const id = toast.loading(t('computing'));
    try {
      const buffer = await file.arrayBuffer();
      let dump: Awaited<ReturnType<typeof dumpDatabase>>;
      if (file.name.endsWith('.json')) {
        dump = JSON.parse(new TextDecoder().decode(buffer));
      } else {
        dump = decode(buffer) as typeof dump;
      }
      await restoreDatabase(dump);
      await loadDatabaseSignals(dbInstance);

      toast.dismiss(id);
      toast.success(t('importSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(`${t('importError')}: ${String(err)}`);
    }
  }

  async function importServerBackup(file: File) {
    const id = toast.loading(t('computing'));
    try {
      await uploadServerBackup(file);
      await loadDatabaseSignals(dbInstance);
      await refreshCapabilities();
      toast.dismiss(id);
      toast.success(t('importSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(`${t('importError')}: ${String(err)}`);
    }
  }

  function handleImportBackupConfirmed() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = isServerDeployment ? '.labby,.msgpack' : '.labby,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (isServerDeployment) {
        await action.run('import', () => importServerBackup(file));
        return;
      }
      await action.run('import', () => importLocalBackup(file));
    };
    input.click();
  }

  function handleImportBackup() {
    confirmDialog(
      t('importOverwriteWarningTitle'),
      t('importOverwriteWarningMessage'),
      handleImportBackupConfirmed,
    );
  }

  async function refreshCapabilities() {
    if (!isServerDeployment) return;
    await capabilitiesQuery.refetch();
  }

  async function handleRunServerBackup(target?: BackupTarget) {
    const id = toast.loading(t('computing'));
    try {
      await runServerBackup({ target });
      await refreshCapabilities();
      toast.dismiss(id);
      toast.success(t('serverBackupRunSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  async function handleDownloadServerBackup(format: 'msgpack') {
    const id = toast.loading(t('computing'));
    try {
      await downloadServerBackup(format);
      toast.dismiss(id);
      toast.success(t('exportSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  const backupCapabilities = capabilities?.backup;
  const emailTaskCapabilities = capabilities?.emailTasks;

  function availabilityBadge(available: boolean) {
    return (
      <span class={available ? s.badge : s.badgeDisabled}>
        {available ? t('available') : t('unavailable')}
      </span>
    );
  }

  return (
    <div>
      <h2 class={clsx(s.sectionTitle, s.mb12)}>
        {t('dataImportExport')}
      </h2>

      <div class={clsx(s.card, s.mb24)}>
        <h3 class={clsx(s.mb12, s.text15, s.fontMedium)}>
          {t('databaseBackup')}
        </h3>
        <p class={clsx(s.mutedParagraph, s.mb12)}>
          {isFrontendOnlyDeployment ? t('localBackupHint') : t('deploymentModeServerHint')}
        </p>
        <div class={s.toolbar}>
          <Button variant="primary" busy={action.pendingKey === 'exportBackup'} disabled={action.pendingKey !== null} onClick={() => void action.run('exportBackup', handleExportBackup)}>
            {t('exportBackupLabby')}
          </Button>
          <Button variant="secondary" busy={action.pendingKey === 'exportJson'} disabled={action.pendingKey !== null} onClick={() => void action.run('exportJson', handleExportJson)}>
            {t('exportBackupJson')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleImportBackup}
            busy={action.pendingKey === 'import'}
            disabled={action.pendingKey !== null || (isServerDeployment && !canManageServerBackups)}
          >
            {t('importBackup')}
          </Button>
        </div>
      </div>

      <div class={clsx(s.card, s.mb24)}>
        <div class={clsx(s.flexBetween, s.mb12)}>
          <h3 class={clsx(s.text15, s.fontMedium)}>{t('serverBackupTitle')}</h3>
          <span class={isServerDeployment ? s.badge : s.badgeDisabled}>
            {deploymentMode === 'server' ? t('deploymentModeServer') : t('deploymentModeFrontendOnly')}
          </span>
        </div>

        {!isServerDeployment && (
          <p class={s.mutedParagraph}>{t('serverBackupUnavailable')}</p>
        )}

        {isServerDeployment && capabilitiesQuery.isInitialLoading && (
          <ContentSkeleton rows={4} label={t('serverCapabilitiesLoading')} />
        )}

        {isServerDeployment && capabilitiesQuery.error && (
          <div role="alert" class={s.formGroup}>
            <p class={s.textDanger}>{t('serverCapabilitiesError')}: {String(capabilitiesQuery.error)}</p>
            <Button variant="secondary" busy={capabilitiesQuery.isPending} onClick={() => void capabilitiesQuery.refetch()}>{t('retry')}</Button>
          </div>
        )}

        {isServerDeployment && backupCapabilities && (
          <>
            <p class={clsx(s.mutedParagraph, s.mb12)}>{t('serverBackupHint')}</p>

            <div class={clsx(s.metricList, s.mb12)}>
              <div class={s.metricRow}>
                <span>{t('backupSchedulerStatus')}</span>
                <span class={s.metricValue}>
                  {backupCapabilities.scheduleEnabled
                    ? t('backupScheduleEnabled')
                    : backupCapabilities.scheduleConfigured
                      ? t('backupScheduleDisabled')
                      : t('backupScheduleNotConfigured')}
                </span>
              </div>
              <div class={s.metricRow}>
                <span>{t('backupConfiguredTarget')}</span>
                <span class={s.metricValue}>
                  {backupCapabilities.configuredTarget ?? t('unavailable')}
                </span>
              </div>
              <div class={s.metricRow}>
                <span>{t('backupConfiguredFormat')}</span>
                <span class={s.metricValue}>{backupCapabilities.configuredFormat}</span>
              </div>
            </div>

            <div class={clsx(s.mb12)}>
              <h4 class={clsx(s.text14, s.fontMedium, s.mb12)}>{t('backupServiceAvailability')}</h4>
              <div class={s.metricList}>
                <div class={s.metricRow}>
                  <span>{t('backupTargetEmail')}</span>
                  {availabilityBadge(backupCapabilities.targets.email)}
                </div>
                <div class={s.metricRow}>
                  <span>{t('backupTargetGoogleDrive')}</span>
                  {availabilityBadge(backupCapabilities.targets['google-drive'])}
                </div>
                <div class={s.metricRow}>
                  <span>{t('backupTargetOneDrive')}</span>
                  {availabilityBadge(backupCapabilities.targets.onedrive)}
                </div>
                {emailTaskCapabilities && (
                  <>
                    <div class={s.metricRow}>
                      <span>{t('emailTaskAutoSendService')}</span>
                      {availabilityBadge(emailTaskCapabilities.autoSend)}
                    </div>
                    <div class={s.metricRow}>
                      <span>{t('emailTaskPublicIcsService')}</span>
                      {availabilityBadge(emailTaskCapabilities.publicScheduleIcs)}
                    </div>
                  </>
                )}
              </div>
            </div>

            {!canManageServerBackups && (
              <p class={clsx(s.mutedParagraph, s.mb12)}>{t('permissionsReadOnly')}</p>
            )}

            <div class={s.toolbar}>
              <Button
                variant="primary"
                onClick={() => void action.run('download', () => handleDownloadServerBackup('msgpack'))}
                busy={action.pendingKey === 'download'}
                disabled={action.pendingKey !== null || !canManageServerBackups}
              >
                {t('downloadServerBackupMsgpack')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void action.run('configured', () => handleRunServerBackup())}
                busy={action.pendingKey === 'configured'}
                disabled={action.pendingKey !== null || !canManageServerBackups || !backupCapabilities.configuredTarget}
              >
                {t('runConfiguredBackup')}
              </Button>
            </div>

            <div class={clsx(s.toolbar, s.mt12)}>
              <Button
                variant="secondary"
                onClick={() => void action.run('email', () => handleRunServerBackup('email'))}
                busy={action.pendingKey === 'email'}
                disabled={action.pendingKey !== null || !canManageServerBackups || !backupCapabilities.targets.email}
              >
                {t('sendBackupToEmail')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void action.run('google-drive', () => handleRunServerBackup('google-drive'))}
                busy={action.pendingKey === 'google-drive'}
                disabled={action.pendingKey !== null || !canManageServerBackups || !backupCapabilities.targets['google-drive']}
              >
                {t('uploadBackupToGoogleDrive')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void action.run('onedrive', () => handleRunServerBackup('onedrive'))}
                busy={action.pendingKey === 'onedrive'}
                disabled={action.pendingKey !== null || !canManageServerBackups || !backupCapabilities.targets.onedrive}
              >
                {t('uploadBackupToOneDrive')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
